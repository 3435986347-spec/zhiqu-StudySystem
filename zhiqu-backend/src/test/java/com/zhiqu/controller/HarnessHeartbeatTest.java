package com.zhiqu.controller;

import com.zhiqu.service.harness.HarnessModelGateway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.asyncDispatch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.request;

/**
 * 模型网关的 SSE：等模型的时候发心跳；出错时告诉命令行值不值得重试。
 * 心跳间隔在测试里调到 50ms（生产 15 秒），假网关 400ms 才回。
 */
class HarnessHeartbeatTest {

    @AfterEach
    void clear() {
        SecurityContextHolder.clearContext();
    }

    private String run(org.mockito.stubbing.Answer<Void> gatewayBehavior) throws Exception {
        HarnessModelGateway gateway = mock(HarnessModelGateway.class);
        doAnswer(gatewayBehavior).when(gateway).stream(anyLong(), any(), any());
        HarnessController controller = new HarnessController(gateway, null, null, null, null, null, null, null, null,
                "0.1.0", "0.1.0", 50);
        MockMvc mvc = MockMvcBuilders.standaloneSetup(controller).build();
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(1L, null, List.of()));
        MvcResult started = mvc.perform(post("/api/harness/model/stream").contentType(MediaType.APPLICATION_JSON)
                .content("{\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}")).andExpect(request().asyncStarted()).andReturn();
        started.getAsyncResult(5000);
        return mvc.perform(asyncDispatch(started)).andReturn().getResponse().getContentAsString();
    }

    @Test
    @DisplayName("模型迟迟不出字：期间有心跳（SSE 注释行），最后照常 done；结束后不再发心跳")
    void 心跳() throws Exception {
        String body = run(inv -> {
            Thread.sleep(400);
            HarnessModelGateway.Sink sink = inv.getArgument(2);
            sink.event("done", Map.of("finishReason", "stop"));
            return null;
        });
        assertTrue(body.contains(":ping"), "没有心跳：\n" + body);
        assertTrue(body.contains("event:done"), body);
        assertTrue(body.lastIndexOf(":ping") < body.indexOf("event:done"), "done 之后不该还有心跳：\n" + body);
    }

    @Test
    @DisplayName("出错：error 事件带 retryable —— 供应商过载是 true，参数错误是 false")
    void 错误带可重试标记() throws Exception {
        String overloaded = run(inv -> { throw new HarnessModelGateway.ModelCallException("过载了", true); });
        assertTrue(overloaded.contains("event:error") && overloaded.contains("\"retryable\":true"), overloaded);
        String bad = run(inv -> { throw new HarnessModelGateway.ModelCallException("Key 不对", false); });
        assertTrue(bad.contains("\"retryable\":false"), bad);
    }
}
