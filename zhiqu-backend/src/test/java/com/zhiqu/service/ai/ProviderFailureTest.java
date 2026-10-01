package com.zhiqu.service.ai;

import com.fasterxml.jackson.core.JsonParseException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.web.client.ResourceAccessException;

import java.io.IOException;
import java.net.ConnectException;
import java.net.HttpRetryException;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 模型供应商出问题时用户看到的那句话（第十九轮）。原来：key 错了是「AI 接口调用失败：AI 接口调用失败」、
 * 502 是一整页 HTML、连不上带着接口地址和 Java 异常原文。
 */
class ProviderFailureTest {

    private static final String KEY = "sk-probe-SECRET-0123456789abcdef";

    @Test
    @DisplayName("按状态码说下一步做什么：401 去检查 Key、402 充值、404 检查地址和模型名、429 说几秒后再试、5xx 稍后再试")
    void 状态码() {
        assertTrue(ProviderFailure.http(401, "", null, KEY).contains("API Key 不对"));
        assertTrue(ProviderFailure.http(402, "{\"error\":{\"message\":\"Insufficient Balance\"}}", null, KEY).contains("余额不足"));
        assertTrue(ProviderFailure.http(404, "", null, KEY).contains("「模型名」"));
        String limited = ProviderFailure.http(429, "", "20", KEY);
        assertTrue(limited.contains("限流") && limited.contains("20 秒之后再试"), limited);
        assertTrue(ProviderFailure.http(429, "", "Wed, 21 Oct 2026 07:28:00 GMT", KEY).contains("等一会儿再试"));
        assertTrue(ProviderFailure.http(503, "", null, KEY).contains("稍后再试"));
        assertTrue(ProviderFailure.http(418, "", null, KEY).contains("HTTP 418"));
    }

    @Test
    @DisplayName("供应商的原因附在后面：JSON 取 message；HTML 整页不要（原来 502 把 nginx 的错误页原样给用户）")
    void 原因() {
        String json = ProviderFailure.http(404, "{\"error\":{\"message\":\"The model `x` does not exist\",\"code\":\"model_not_found\"}}", null, null);
        assertTrue(json.endsWith("供应商说：The model `x` does not exist"), json);
        String html = ProviderFailure.http(502, "<html>\r\n<head><title>502 Bad Gateway</title></head><body><center>nginx</center></body></html>", null, null);
        assertEquals("模型服务暂时出错了（HTTP 502），稍后再试", html);
        assertEquals("", ProviderFailure.detail("<!DOCTYPE html><p>hi</p>", null));
        assertEquals(301, ProviderFailure.detail("长".repeat(1000), null).length(), "原因最多 300 字加省略号");
    }

    @Test
    @DisplayName("供应商回显的 key 要遮住：配置里那一把、长得像 key 的、Bearer 后面的 —— 系统模型的 key 是管理员的，看报错的是普通用户")
    void 遮住key() {
        String echoed = ProviderFailure.http(401,
                "{\"error\":{\"message\":\"Incorrect API key provided: " + KEY + ". You can find your API key at https://x\"}}", null, KEY);
        assertFalse(echoed.contains("SECRET"), echoed);
        assertTrue(echoed.contains("****cdef"), "留末四位，用户认得出是哪一把：" + echoed);
        // 两道各判各的：配置里那把 key 不一定长得像 key（自建服务随便起的），长得像 key 的也不一定是配置里那把
        String odd = ProviderFailure.redact("rejected token Zq7mK2pLx9Wv4t", "Zq7mK2pLx9Wv4t");
        assertEquals("rejected token ****Wv4t", odd, "配置里那把 key 没有前缀也要遮住");
        assertFalse(ProviderFailure.redact("key sk-other-9876543210abcdefgh is invalid", null).contains("9876543210"));
        assertFalse(ProviderFailure.redact("header Authorization: Bearer abc.def-ghi_jkl012 rejected", null).contains("abc.def"));
        assertFalse(ProviderFailure.redact("AIzaSyA1234567890abcdefghijklmnopqrstu", null).contains("1234567890"));
        String words = "skeleton_structure_description and task_management_system";
        assertEquals(words, ProviderFailure.redact(words, null), "普通的词不能被当成 key 遮掉");
    }

    @Test
    @DisplayName("连不上、超时、断开、坏 JSON：各说各的，不带接口地址、不带异常原文")
    void 网络() {
        String url = "http://10.1.2.3:8000/v1/chat/completions";
        ResourceAccessException refused = new ResourceAccessException("I/O error on POST request for \"" + url + "\": Connection refused",
                new ConnectException("Connection refused"));
        String m = ProviderFailure.io(refused, 60);
        assertTrue(m.contains("连接被拒绝") && !m.contains("10.1.2.3") && !m.contains("I/O error"), m);
        assertTrue(ProviderFailure.io(new ResourceAccessException("x", new UnknownHostException("no-such-host.invalid")), 60).contains("域名解析不了"));
        assertTrue(ProviderFailure.io(new ResourceAccessException("x", new SocketTimeoutException("Read timed out")), 60).contains("60 秒没有任何输出"));
        assertTrue(ProviderFailure.io(new ResourceAccessException("x", new SocketTimeoutException("Connect timed out")), 60).contains("连接模型服务超时"));
        assertTrue(ProviderFailure.io(new SocketTimeoutException("Read timed out"), 0).contains("太久没有响应"));
        String json = ProviderFailure.io(new ResourceAccessException("x", new JsonParseException(null, "Unexpected end-of-input at [Source: REDACTED]")), 60);
        assertTrue(json.contains("不是合法的 JSON") && !json.contains("Source"), json);
        assertTrue(ProviderFailure.io(new ResourceAccessException("x", new HttpRetryException("cannot retry due to server authentication, in streaming mode", 401)), 60)
                .contains("API Key 不对"), "流式 POST 遇到 401，JDK 抛的是这个 —— 状态码藏在里面");
        assertTrue(ProviderFailure.io(new ResourceAccessException("x", new SocketException("Connection reset")), 60).contains("中途断开"));
        assertTrue(ProviderFailure.io(new ResourceAccessException("I/O error on POST request for \"" + url + "\": Premature EOF",
                new IOException("Premature EOF")), 60).contains("中途断开"), "供应商进程崩了、连接硬断：JDK 报的是这个");
        assertEquals("和模型服务通信失败", ProviderFailure.io(new IOException("weird " + url), 60));
    }

    @Test
    @DisplayName("哪些值得原样再试：429 / 5xx / 断开 / 超时是；key 错、地址错、域名解析不了、回的不是 JSON 不是")
    void 能不能重试() {
        assertTrue(ProviderFailure.retryable(429));
        assertTrue(ProviderFailure.retryable(502));
        assertFalse(ProviderFailure.retryable(401));
        assertFalse(ProviderFailure.retryable(404));
        assertTrue(ProviderFailure.retryableIo(new ResourceAccessException("x", new SocketTimeoutException("Read timed out"))));
        assertTrue(ProviderFailure.retryableIo(new ResourceAccessException("x", new ConnectException("Connection refused"))));
        assertFalse(ProviderFailure.retryableIo(new ResourceAccessException("x", new UnknownHostException("h"))));
        assertFalse(ProviderFailure.retryableIo(new ResourceAccessException("x", new JsonParseException(null, "bad"))));
    }
}
