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
import static org.junit.jupiter.api.Assertions.assertFalse;
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

    /** 请求里带 temperature 就回 400（像 OpenAI 的推理模型那样），不带就回 reply */
    private String fakeRejectingTemperature(String reply) throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", ex -> {
            JsonNode body = JSON.readTree(ex.getRequestBody().readAllBytes());
            bodies.add(body);
            boolean reject = body.has("temperature");
            byte[] bytes = (reject ? "{\"error\":{\"message\":\"Unsupported value: 'temperature' does not support 0 with this model.\"}}" : reply)
                    .getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().add("Content-Type", "application/json");
            ex.sendResponseHeaders(reject ? 400 : 200, bytes.length);
            try (OutputStream out = ex.getResponseBody()) {
                out.write(bytes);
            }
        });
        server.start();
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private static AiModelConfig config(String type, String url) {
        AiModelConfig c = new AiModelConfig();
        c.setProviderType(type);
        c.setApiUrl(url);
        c.setModelName("m");
        c.setEncryptedApiKey("e");
        return c;
    }

    @Test
    @DisplayName("第八十九轮：code agent 干活的轮带温度（limits.withTemperature）—— OpenAI 兼容和 Anthropic 都发；默认那一档（QUICK）照旧跟 app.ai.temperature（空 = 不发）")
    void 干活的轮带温度() throws Exception {
        String url = fake("{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"role\":\"assistant\",\"content\":\"好\"}}]}");
        client().callToolTurn(config("OPENAI_COMPATIBLE", url), MESSAGES, TOOLS, ModelProviderClient.ToolTurnLimits.QUICK.withTemperature(0.0));
        assertEquals(0.0, bodies.get(0).path("temperature").asDouble(-1));
        client().callToolTurn(config("OPENAI_COMPATIBLE", url), MESSAGES, TOOLS, ModelProviderClient.ToolTurnLimits.QUICK);
        assertFalse(bodies.get(1).has("temperature"), "没给温度的那一档不该带");
        server.stop(0);
        String anthropic = fake("{\"content\":[{\"type\":\"text\",\"text\":\"好\"}],\"stop_reason\":\"end_turn\"}");
        client().callToolTurn(config("ANTHROPIC", anthropic), MESSAGES, TOOLS, ModelProviderClient.ToolTurnLimits.QUICK.withTemperature(0.0));
        assertEquals(0.0, bodies.get(2).path("temperature").asDouble(-1));
    }

    @Test
    @DisplayName("第八十九轮：供应商不认 temperature（400 里提到它）—— 去掉它重试一次，这次成功就照常返回")
    void 温度不认就去掉() throws Exception {
        String url = fakeRejectingTemperature("{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"role\":\"assistant\",\"content\":\"好\"}}]}");
        JsonNode msg = client().callToolTurn(config("OPENAI_COMPATIBLE", url), MESSAGES, TOOLS, ModelProviderClient.ToolTurnLimits.QUICK.withTemperature(0.0));
        assertEquals("好", msg.path("content").asText());
        assertEquals(2, bodies.size());
        assertTrue(bodies.get(0).has("temperature"));
        assertFalse(bodies.get(1).has("temperature"));
    }

    @Test
    @DisplayName("第八十九轮：Anthropic 那条同样 —— 不认 temperature 就去掉它重试一次")
    void 温度不认就去掉_anthropic() throws Exception {
        String url = fakeRejectingTemperature("{\"content\":[{\"type\":\"text\",\"text\":\"好\"}],\"stop_reason\":\"end_turn\"}");
        client().callToolTurn(config("ANTHROPIC", url), MESSAGES, TOOLS, ModelProviderClient.ToolTurnLimits.QUICK.withTemperature(0.0));
        assertEquals(2, bodies.size());
        assertTrue(bodies.get(0).has("temperature"));
        assertFalse(bodies.get(1).has("temperature"));
    }

    private ModelProviderClient client() {
        SensitiveCryptoService crypto = mock(SensitiveCryptoService.class);
        when(crypto.decrypt(any())).thenReturn("sk");
        return new ModelProviderClient(JSON, crypto, "2023-06-01", "");
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
        assertTrue(bodies.get(0).path("thinking").isMissingNode(), "不是 DeepSeek 也塞了 thinking 参数：" + bodies.get(0));
    }

    /**
     * 第五十四轮：用户在桌面应用里「每次都要等待好几分钟，在 cli 里面就很快」—— 同一个 deepseek-v4-pro。
     * 命令行一直明说不要思考（HarnessModelGateway：thinking disabled），code agent 的工具轮什么都不说，DeepSeek 就默认想，每一轮都想一阵。
     */
    @Test
    @DisplayName("DeepSeek 的工具轮明说不要思考（和命令行一样）—— 不说的话它默认想，code agent 每一轮都慢")
    void deepSeek工具轮不思考() throws Exception {
        String url = fake("{\"choices\":[{\"finish_reason\":\"stop\",\"message\":{\"role\":\"assistant\",\"content\":\"好\"}}]}");
        AiModelConfig config = new AiModelConfig();
        config.setProviderType("OPENAI_COMPATIBLE");
        config.setApiUrl(url);
        config.setModelName("deepseek-v4-pro");
        config.setEncryptedApiKey("e");
        client().callToolTurn(config, MESSAGES, TOOLS, ModelProviderClient.ToolTurnLimits.QUICK);
        assertEquals("disabled", bodies.get(0).at("/thinking/type").asText(), "DeepSeek 的工具轮没说不要思考：" + bodies.get(0));
    }
}
