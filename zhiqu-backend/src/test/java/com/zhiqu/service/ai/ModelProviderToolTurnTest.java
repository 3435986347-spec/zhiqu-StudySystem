package com.zhiqu.service.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import com.zhiqu.entity.AiModelConfig;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 计划里记的已知问题：Anthropic 配置被标成支持工具调用，code agent 却把 OpenAI 格式的请求发给它。
 * {@code callToolTurn} 按供应商分派 —— 这里用真 HTTP 看发出去的是什么、回来的变成了什么。
 */
class ModelProviderToolTurnTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private HttpServer server;
    private final List<String> paths = new ArrayList<>();
    private final List<JsonNode> bodies = new ArrayList<>();

    @AfterEach
    void stop() {
        if (server != null) server.stop(0);
    }

    private String fake(String reply) throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", ex -> {
            paths.add(ex.getRequestURI().getPath());
            bodies.add(JSON.readTree(ex.getRequestBody().readAllBytes()));
            byte[] bytes = reply.getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().add("Content-Type", "application/json");
            ex.sendResponseHeaders(200, bytes.length);
            try (OutputStream out = ex.getResponseBody()) {
                out.write(bytes);
            }
        });
        server.start();
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private ModelProviderClient client() {
        SensitiveCryptoService crypto = mock(SensitiveCryptoService.class);
        when(crypto.decrypt(any())).thenReturn("sk");
        return new ModelProviderClient(JSON, crypto, "2023-06-01", "", true);
    }

    private static final List<Map<String, Object>> MESSAGES = List.of(
            Map.of("role", "system", "content", "规则"),
            Map.of("role", "user", "content", "看看 a.js"));
    private static final List<Map<String, Object>> TOOLS = List.of(Map.of("type", "function",
            "function", Map.of("name", "read_workspace_file", "parameters", Map.of("type", "object"))));

    @Test
    @DisplayName("Anthropic 配置：发到 /v1/messages、system 在顶层、工具是 input_schema；回来的 tool_use 变成 tool_calls")
    void anthropic() throws Exception {
        String url = fake("{\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"read_workspace_file\",\"input\":{\"path\":\"a.js\"}}],"
                + "\"stop_reason\":\"tool_use\"}");
        AiModelConfig config = new AiModelConfig();
        config.setProviderType("ANTHROPIC");
        config.setApiUrl(url);
        config.setModelName("claude");
        config.setEncryptedApiKey("e");
        JsonNode msg = client().callToolTurn(config, MESSAGES, TOOLS, ModelProviderClient.ToolTurnLimits.QUICK);
        assertEquals("/v1/messages", paths.get(0));
        assertEquals("规则", bodies.get(0).path("system").asText());
        assertTrue(bodies.get(0).path("tools").path(0).has("input_schema"));
        assertEquals("read_workspace_file", msg.path("tool_calls").path(0).path("function").path("name").asText());
        assertEquals("a.js", JSON.readTree(msg.path("tool_calls").path(0).path("function").path("arguments").asText()).path("path").asText());
    }

    @Test
    @DisplayName("OpenAI 兼容配置：照旧发到 /chat/completions，原样返回 message")
    void openAi() throws Exception {
        String url = fake("{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"role\":\"assistant\",\"content\":\"好\"}}]}");
        AiModelConfig config = new AiModelConfig();
        config.setProviderType("OPENAI_COMPATIBLE");
        config.setApiUrl(url);
        config.setModelName("m");
        config.setEncryptedApiKey("e");
        JsonNode msg = client().callToolTurn(config, MESSAGES, TOOLS, ModelProviderClient.ToolTurnLimits.QUICK);
        assertEquals("/chat/completions", paths.get(0));
        assertEquals("system", bodies.get(0).path("messages").path(0).path("role").asText());
        assertEquals("好", msg.path("content").asText());
    }
}
