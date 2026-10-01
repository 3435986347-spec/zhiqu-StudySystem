package com.zhiqu.security;

import com.zhiqu.service.concurrency.RedisRateLimiter;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 限流的几个桶各挡什么（第十五轮）。AI 那一桶（40 次 / 分钟）只算写操作 —— 原来 /api/ai/** 的读也算进去：
 * AI 助手打开一次 6 个读，刷新六七次就整页「加载失败」；回答到一半刷新后每 2 秒轮询一次，长回答一分多钟就把桶用完。
 */
class RateLimitBucketsTest {

    private RateLimitFilter filter() {
        StringRedisTemplate redis = mock(StringRedisTemplate.class);
        when(redis.execute(any(org.springframework.data.redis.core.script.RedisScript.class), any(java.util.List.class), any(Object[].class)))
                .thenThrow(new RedisConnectionFailureException("down"));
        when(redis.opsForValue()).thenThrow(new RedisConnectionFailureException("down"));
        return new RateLimitFilter(new RedisRateLimiter(redis), new ClientIpResolver());   // Redis 连不上：走进程内窗口
    }

    private static int status(RateLimitFilter f, String method, String path) throws Exception {
        MockHttpServletRequest req = new MockHttpServletRequest(method, path);
        MockHttpServletResponse res = new MockHttpServletResponse();
        f.doFilter(req, res, new MockFilterChain());
        return res.getStatus();
    }

    @Test
    @DisplayName("AI 助手的读（打开页面、轮询消息）一分钟 60 次：一次都不拦")
    void AI页面的读不走AI桶() throws Exception {
        RateLimitFilter f = filter();
        for (int i = 0; i < 60; i++) {
            String path = i % 2 == 0 ? "/api/ai/messages" : "/api/ai/notebooks";
            assertEquals(200, status(f, "GET", path), "第 " + (i + 1) + " 个读被拦了");
        }
    }

    @Test
    @DisplayName("发消息调模型（写）照样一分钟 40 次：第 41 次 429")
    void AI的写照样限() throws Exception {
        RateLimitFilter f = filter();
        for (int i = 0; i < 40; i++) {
            assertEquals(200, status(f, "POST", "/api/ai/chat/stream"), "第 " + (i + 1) + " 次就被拦了");
        }
        assertEquals(429, status(f, "POST", "/api/ai/chat/stream"));
    }

    @Test
    @DisplayName("桶的划分")
    void 桶() {
        RateLimitFilter f = filter();
        assertEquals("api", f.limitFor("GET", "/api/ai/messages").key());
        assertEquals("ai", f.limitFor("POST", "/api/ai/chat/stream").key());
        assertEquals("ai", f.limitFor("DELETE", "/api/ai/messages/3").key());
        assertEquals("auth", f.limitFor("POST", "/api/auth/login").key());
        assertEquals("harness-model", f.limitFor("POST", "/api/harness/model/stream").key());
        assertEquals("api", f.limitFor("GET", "/api/task/list").key());
    }
}
