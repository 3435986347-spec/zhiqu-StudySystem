package com.zhiqu.service.harness;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.AiModelConfig;
import com.zhiqu.entity.HarnessUsage;
import com.zhiqu.mapper.HarnessUsageMapper;
import com.zhiqu.service.AiService;
import com.zhiqu.service.ai.ModelProviderClient;
import com.zhiqu.service.ai.stream.ModelStreamAdapterFactory;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 模型网关用真的 HTTP 跑：本机起一个假模型，按两家供应商真实的流式格式回。
 * 断言落在「命令行收到了什么事件」「供应商收到了什么请求」这两头，中间怎么实现不管。
 */
class HarnessModelGatewayTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private HttpServer server;
    private final List<JsonNode> requests = Collections.synchronizedList(new ArrayList<>());
    private final List<Map<String, String>> headers = Collections.synchronizedList(new ArrayList<>());

    @AfterEach
    void stop() {
        if (server != null) server.stop(0);
    }

    /** 起假模型：handler 拿到请求体，返回 {状态码, 响应体}。 */
    private String fakeModel(Function<JsonNode, Object[]> handler) throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", ex -> {
            JsonNode body = JSON.readTree(ex.getRequestBody().readAllBytes());
            requests.add(body);
            Map<String, String> h = new LinkedHashMap<>();
            ex.getRequestHeaders().forEach((k, v) -> h.put(k.toLowerCase(), v.get(0)));
            headers.add(h);
            Object[] reply = handler.apply(body);
            byte[] bytes = ((String) reply[1]).getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().add("Content-Type", reply.length > 2 ? (String) reply[2]
                    : (int) reply[0] == 200 ? "text/event-stream" : "application/json");
            ex.sendResponseHeaders((int) reply[0], bytes.length);
            try (OutputStream out = ex.getResponseBody()) {
                out.write(bytes);
            }
        });
        server.start();
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private static String sse(String... datas) {
        StringBuilder sb = new StringBuilder();
        for (String d : datas) sb.append("data: ").append(d).append("\n\n");
        return sb.toString();
    }

    private final AiService aiService = mock(AiService.class);
    private final HarnessUsageMapper usageMapper = mock(HarnessUsageMapper.class);

    private HarnessModelGateway gateway(boolean allowPrivate) {
        SensitiveCryptoService crypto = mock(SensitiveCryptoService.class);
        when(crypto.decrypt(any())).thenReturn("sk-test");
        ModelProviderClient provider = new ModelProviderClient(JSON, crypto, "2023-06-01", "", allowPrivate);
        return new HarnessModelGateway(aiService, provider, new ModelStreamAdapterFactory(List.of()), usageMapper, JSON, "2023-06-01");
    }

    private AiModelConfig model(String type, String url, Integer window) {
        AiModelConfig c = new AiModelConfig();
        c.setId(7L);
        c.setProviderType(type);
        c.setApiUrl(url);
        c.setModelName("fake-model");
        c.setDisplayName("假模型");
        c.setEncryptedApiKey("enc");
        c.setEnabled(1);
        c.setContextWindowTokens(window);
        when(aiService.resolveModel(anyLong(), any())).thenReturn(c);
        return c;
    }

    private static final List<Map<String, Object>> TOOLS = List.of(Map.of("type", "function",
            "function", Map.of("name", "write_file", "parameters", Map.of("type", "object"))));

    private static Map<String, Object> body(List<Map<String, Object>> messages) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("messages", messages);
        b.put("tools", TOOLS);
        return b;
    }

    private static final List<Map<String, Object>> ASK = List.of(
            Map.of("role", "system", "content", "你是 zhiqu"),
            Map.of("role", "user", "content", "做个小游戏"));

    private final List<String> events = new ArrayList<>();
    private final Map<String, Map<String, Object>> last = new LinkedHashMap<>();

    private HarnessModelGateway.Sink sink() {
        return (name, data) -> {
            events.add(name);
            last.put(name, data);
        };
    }

    @Test
    @DisplayName("OpenAI：工具名一到就报、参数长了就报进度、done 里是拼好的完整调用；请求带着工具与 16384 上限")
    @SuppressWarnings("unchecked")
    void openAi() throws Exception {
        String big = "x".repeat(5000);
        String url = fakeModel(b -> new Object[]{200, sse(
                "{\"choices\":[{\"delta\":{\"content\":\"好的\"}}]}",
                "{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"write_file\",\"arguments\":\"{\\\"path\\\":\\\"g/index.html\\\",\\\"content\\\":\\\"\"}}]}}]}",
                "{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"" + big + "\"}}]}}]}",
                "{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"}\"}}]}}]}",
                "{\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":50,\"completion_tokens\":1300}}",
                "[DONE]")});
        model("OPENAI_COMPATIBLE", url, null);
        gateway(true).stream(1L, body(ASK), sink());

        assertEquals("start", events.get(0));
        // 先断言两个都在：indexOf 找不到是 -1，只比先后的话「tool_call 根本没发」也会通过（扰动 T10 照出来的）
        assertTrue(events.contains("tool_call") && events.contains("tool_progress"), "工具名与参数进度都要转出去：" + events);
        assertTrue(events.indexOf("tool_call") < events.indexOf("tool_progress"), "工具名要先于参数进度：" + events);
        assertEquals("done", events.get(events.size() - 1));
        Map<String, Object> done = last.get("done");
        assertEquals("tool_calls", done.get("finishReason"));
        Map<String, Object> call = ((List<Map<String, Object>>) ((Map<String, Object>) done.get("message")).get("tool_calls")).get(0);
        String args = String.valueOf(((Map<String, Object>) call.get("function")).get("arguments"));
        assertEquals(5000, JSON.readTree(args).path("content").asText().length(), "参数没有拼完整");

        JsonNode sent = requests.get(0);
        assertEquals(16384, sent.path("max_tokens").asInt());
        assertTrue(sent.path("stream").asBoolean());
        assertEquals("write_file", sent.path("tools").path(0).path("function").path("name").asText());
        assertEquals("Bearer sk-test", headers.get(0).get("authorization"), "API Key 由服务器带上");

        ArgumentCaptor<HarnessUsage> usage = ArgumentCaptor.forClass(HarnessUsage.class);
        verify(usageMapper).insert(usage.capture());
        assertEquals(50, usage.getValue().getPromptTokens());
        assertEquals(1300, usage.getValue().getCompletionTokens());
        assertEquals(0, usage.getValue().getEstimated());
    }

    @Test
    @DisplayName("供应商嫌输出上限太大（400）：降到 8192 重试一次，这次成功就不报错")
    void 上限回退() throws Exception {
        String url = fakeModel(b -> b.path("max_tokens").asInt() > 8192
                ? new Object[]{400, "{\"error\":{\"message\":\"max_tokens must be less than or equal to 8192\"}}"}
                : new Object[]{200, sse("{\"choices\":[{\"delta\":{\"content\":\"好\"},\"finish_reason\":\"stop\"}]}")});
        model("OPENAI_COMPATIBLE", url, null);
        gateway(true).stream(1L, body(ASK), sink());
        assertEquals(List.of(16384, 8192), requests.stream().map(r -> r.path("max_tokens").asInt()).toList());
        assertEquals(8192, last.get("done").get("maxTokens"));
        assertFalse(events.contains("error"));
    }

    @Test
    @DisplayName("别的 400 不重试，原样说出供应商的原因，并标成「重试也没用」")
    void 别的错误不重试() throws Exception {
        String url = fakeModel(b -> new Object[]{400, "{\"error\":{\"message\":\"invalid api key\"}}"});
        model("OPENAI_COMPATIBLE", url, null);
        HarnessModelGateway.ModelCallException e = assertThrows(HarnessModelGateway.ModelCallException.class,
                () -> gateway(true).stream(1L, body(ASK), sink()));
        assertTrue(e.getMessage().contains("invalid api key"), e.getMessage());
        assertFalse(e.retryable());
        assertEquals(1, requests.size());
    }

    @Test
    @DisplayName("供应商 503 / 429、连不上：标成可重试（命令行在还没输出时会自己重来）")
    void 临时错误可重试() throws Exception {
        String url = fakeModel(b -> new Object[]{503, "{\"error\":{\"message\":\"overloaded\"}}"});
        model("OPENAI_COMPATIBLE", url, null);
        assertTrue(assertThrows(HarnessModelGateway.ModelCallException.class,
                () -> gateway(true).stream(1L, body(ASK), sink())).retryable());
        server.stop(0);
        server = null;
        model("OPENAI_COMPATIBLE", "http://127.0.0.1:1", null);
        HarnessModelGateway.ModelCallException down = assertThrows(HarnessModelGateway.ModelCallException.class,
                () -> gateway(true).stream(1L, body(ASK), sink()));
        assertTrue(down.retryable(), down.getMessage());
        assertTrue(HarnessModelGateway.retryableStatus(429));
        assertFalse(HarnessModelGateway.retryableStatus(401));
    }

    @Test
    @DisplayName("Anthropic：system 在顶层、工具结果变成 tool_result、x-api-key 由服务器带上；回来的是 OpenAI 格式")
    @SuppressWarnings("unchecked")
    void anthropic() throws Exception {
        String url = fakeModel(b -> new Object[]{200, sse(
                "{\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":9}}}",
                "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"write_file\",\"input\":{}}}",
                "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\\\"a.html\\\"}\"}}",
                "{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":5}}")});
        model("ANTHROPIC", url, null);
        List<Map<String, Object>> loop = new ArrayList<>(ASK);
        loop.add(Map.of("role", "assistant", "content", "", "tool_calls", List.of(
                Map.of("id", "t0", "type", "function", "function", Map.of("name", "list_files", "arguments", "{}")))));
        loop.add(Map.of("role", "tool", "tool_call_id", "t0", "content", "（空目录）"));
        gateway(true).stream(1L, body(loop), sink());

        JsonNode sent = requests.get(0);
        assertEquals("你是 zhiqu", sent.path("system").asText());
        assertEquals("tool_result", sent.path("messages").path(2).path("content").path(0).path("type").asText(), sent.toString());
        assertEquals("write_file", sent.path("tools").path(0).path("name").asText());
        assertTrue(sent.path("tools").path(0).has("input_schema"));
        assertEquals("sk-test", headers.get(0).get("x-api-key"));
        Map<String, Object> msg = (Map<String, Object>) last.get("done").get("message");
        assertEquals("t1", ((List<Map<String, Object>>) msg.get("tool_calls")).get(0).get("id"));
        assertEquals("tool_calls", last.get("done").get("finishReason"));
    }

    @Test
    @DisplayName("不支持工具调用的模型带着工具来：直接说清楚，一个请求都不发")
    void 不支持工具() throws Exception {
        String url = fakeModel(b -> new Object[]{200, sse()});
        model("GEMINI", url, null);
        BusinessException e = assertThrows(BusinessException.class, () -> gateway(true).stream(1L, body(ASK), sink()));
        assertTrue(e.getMessage().contains("不支持工具调用"), e.getMessage());
        assertTrue(requests.isEmpty());
    }

    @Test
    @DisplayName("SSRF：没开 allow-private-provider-url 时，指向本机的模型地址一律拒，请求发不出去")
    void ssrf() throws Exception {
        String url = fakeModel(b -> new Object[]{200, sse()});
        model("OPENAI_COMPATIBLE", url, null);
        assertThrows(BusinessException.class, () -> gateway(false).stream(1L, body(ASK), sink()));
        assertTrue(requests.isEmpty(), "校验必须在发请求之前");
        verify(usageMapper, never()).insert(any(HarnessUsage.class));
    }

    @Test
    @DisplayName("按模型的上下文窗口裁：窗口小的模型，最早的几轮被丢掉，start 里说出丢了几条")
    void 按窗口裁() throws Exception {
        String url = fakeModel(b -> new Object[]{200, sse("{\"choices\":[{\"delta\":{\"content\":\"好\"},\"finish_reason\":\"stop\"}]}")});
        model("OPENAI_COMPATIBLE", url, 8000);
        List<Map<String, Object>> longChat = new ArrayList<>();
        longChat.add(Map.of("role", "system", "content", "系统"));
        for (int i = 0; i < 20; i++) {
            longChat.add(Map.of("role", "user", "content", "第" + i + "轮" + "字".repeat(500)));
            longChat.add(Map.of("role", "assistant", "content", "答".repeat(500)));
        }
        gateway(true).stream(1L, body(longChat), sink());
        int dropped = ((Number) last.get("start").get("droppedMessages")).intValue();
        assertTrue(dropped > 0, "窗口 8000 的模型不该收到 2 万字");
        assertEquals(longChat.size() - dropped, requests.get(0).path("messages").size());
        assertEquals(4000, last.get("start").get("maxTokens"), "输出上限不超过窗口的一半");
    }

    @Test
    @DisplayName("命令行断开（发事件失败）：抛 ClientGone，不再往下读")
    void 断开() throws Exception {
        String url = fakeModel(b -> new Object[]{200, sse(
                "{\"choices\":[{\"delta\":{\"content\":\"一\"}}]}", "{\"choices\":[{\"delta\":{\"content\":\"二\"}}]}")});
        model("OPENAI_COMPATIBLE", url, null);
        List<String> seen = new ArrayList<>();
        assertThrows(HarnessModelGateway.ClientGone.class, () -> gateway(true).stream(1L, body(ASK), (name, data) -> {
            seen.add(name);
            if ("delta".equals(name)) throw new IOException("Broken pipe");
        }));
        assertEquals(List.of("start", "delta"), seen, "断开之后不该再发");
        verify(usageMapper, never()).insert(any(HarnessUsage.class));
    }

    // ── 第十九轮：供应商那一侧不配合 ─────────────────────────────────────

    private HarnessModelGateway.ModelCallException failure(Function<JsonNode, Object[]> handler) throws Exception {
        model("OPENAI_COMPATIBLE", fakeModel(handler), null);
        HarnessModelGateway.ModelCallException e = assertThrows(HarnessModelGateway.ModelCallException.class,
                () -> gateway(true).stream(1L, body(ASK), sink()));
        assertFalse(events.contains("done"), "出了错就不该再发 done：" + events);
        for (String leak : List.of("http://", "I/O error", "Source:", "sk-test")) {
            assertFalse(e.getMessage().contains(leak), "给终端的话里不该有「" + leak + "」：" + e.getMessage());
        }
        return e;
    }

    @Test
    @DisplayName("说到一半连接断了（没有 [DONE]、没有 finish_reason）：不发 done，说「没说完」；已经输出过就不可重试（重来会重复），还没输出过可以")
    void 说到一半断开() throws Exception {
        HarnessModelGateway.ModelCallException after = failure(b -> new Object[]{200, sse(
                "{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"write_file\",\"arguments\":\"{\\\"path\\\":\"}}]}}]}")});
        assertTrue(after.getMessage().contains("没说完"), after.getMessage());
        assertFalse(after.retryable(), "半截的工具调用已经转给命令行了");
        server.stop(0);
        events.clear();
        HarnessModelGateway.ModelCallException before = failure(b -> new Object[]{200, sse(
                "{\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}")});
        assertTrue(before.getMessage().contains("没说完"), before.getMessage());
        assertTrue(before.retryable(), "一个字都还没收到：可以原样重来");
    }

    @Test
    @DisplayName("有 finish_reason 没有 [DONE]：算说完了（有的供应商不发 [DONE]）")
    void 只有finishReason() throws Exception {
        model("OPENAI_COMPATIBLE", fakeModel(b -> new Object[]{200, sse(
                "{\"choices\":[{\"delta\":{\"content\":\"好\"},\"finish_reason\":\"stop\"}]}")}), null);
        gateway(true).stream(1L, body(ASK), sink());
        assertEquals("done", events.get(events.size() - 1));
    }

    @Test
    @DisplayName("接口地址填成了官网（200 回一页 HTML）：说地址可能填错了，不可重试（原来是一个空的 done）")
    void 回的是网页() throws Exception {
        HarnessModelGateway.ModelCallException e = failure(b -> new Object[]{200, "<!doctype html><html><body>Welcome</body></html>", "text/html"});
        assertTrue(e.getMessage().contains("「接口地址」可能填错了"), e.getMessage());
        assertFalse(e.retryable());
    }

    @Test
    @DisplayName("空回答（直接 [DONE]）：说什么都没说，可以重试（原来发一个空的 done，那一轮一个字不打就结束）")
    void 空回答() throws Exception {
        HarnessModelGateway.ModelCallException e = failure(b -> new Object[]{200, sse("[DONE]")});
        assertTrue(e.getMessage().contains("什么都没说"), e.getMessage());
        assertTrue(e.retryable());
    }

    @Test
    @DisplayName("流里一块 JSON 坏了：说数据格式不对、不可重试（原来说成「连不上模型服务：I/O error on POST request for http://…」还标可重试）")
    void 坏JSON() throws Exception {
        HarnessModelGateway.ModelCallException e = failure(b -> new Object[]{200,
                "data: {\"choices\":[{\"delta\":{\"content\":\"坏\n\n"});
        assertTrue(e.getMessage().contains("不是合法的 JSON"), e.getMessage());
        assertFalse(e.retryable());
    }

    @Test
    @DisplayName("key 错（401，报错里回显了 key）：说「API Key 不对」，key 遮住")
    void key错() throws Exception {
        HarnessModelGateway.ModelCallException e = failure(b -> new Object[]{401,
                "{\"error\":{\"message\":\"Incorrect API key provided: sk-test\"}}"});
        assertTrue(e.getMessage().contains("API Key 不对"), e.getMessage());
        assertFalse(e.retryable());
    }
}
