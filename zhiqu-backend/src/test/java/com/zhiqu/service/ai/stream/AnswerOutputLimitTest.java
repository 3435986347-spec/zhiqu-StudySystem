package com.zhiqu.service.ai.stream;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.AiModelConfig;
import com.zhiqu.service.ai.OutputLimits;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 第五十四轮：写回答那一次的输出上限。用户 2026-10-09 在桌面应用里：DeepSeek、深度思考开着，「模型把这次的输出额度全用在了思考上」——
 * 网页写死 4096，思考也算在里面；同一个模型在命令行里没事（命令行 16384）。现在和命令行同一档，供应商不收就一档档降（OutputLimits）。
 * 用真的 HTTP 看发出去的 max_tokens、被拒之后怎么降、不是在说上限的错误不重来。
 */
class AnswerOutputLimitTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private HttpServer server;
    private final List<JsonNode> bodies = new ArrayList<>();

    @AfterEach
    void stop() {
        if (server != null) server.stop(0);
    }

    /** 假的模型服务：按请求体决定回什么（状态码 + 正文 + 类型） */
    private String fake(Function<JsonNode, String[]> reply) throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", ex -> {
            JsonNode body = JSON.readTree(ex.getRequestBody().readAllBytes());
            bodies.add(body);
            String[] r = reply.apply(body);
            byte[] bytes = r[1].getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().add("Content-Type", r[2]);
            ex.sendResponseHeaders(Integer.parseInt(r[0]), bytes.length);
            try (OutputStream out = ex.getResponseBody()) {
                out.write(bytes);
            }
        });
        server.start();
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private static String[] sse(String text) {
        return new String[]{"200", "data: {\"choices\":[{\"delta\":{\"content\":\"" + text + "\"}}]}\n\n"
                + "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", "text/event-stream"};
    }

    private static AiModelConfig config(String url, String model) {
        AiModelConfig c = new AiModelConfig();
        c.setProviderType("OPENAI_COMPATIBLE");
        c.setApiUrl(url + "/v1/chat/completions");
        c.setModelName(model);
        return c;
    }

    private static ModelStreamRequest request(AiModelConfig config, String reasoningMode) {
        return new ModelStreamRequest(config, "sk", List.of(Map.of("role", "user", "content", "画一只鹈鹕")), reasoningMode, "2023-06-01");
    }

    @Test
    @DisplayName("DeepSeek、深度思考：一次就给 16384（原来 4096，想完就没地方写回答），并且明说要思考")
    void 深度思考给够() throws Exception {
        String url = fake(body -> sse("好"));
        ModelStreamResult result = new OpenAiChatCompatibleAdapter().stream(request(config(url, "deepseek-v4-pro"), "DEEP"), e -> { });
        assertEquals("好", result.content());
        assertEquals(1, bodies.size());
        assertEquals(OutputLimits.ANSWER_MAX_TOKENS, bodies.get(0).path("max_tokens").asInt());
        assertEquals(16_384, OutputLimits.ANSWER_MAX_TOKENS, "和命令行（HarnessModelGateway.DEFAULT_MAX_TOKENS）同一档");
        assertEquals("enabled", bodies.get(0).at("/thinking/type").asText(), "深度思考开着却没让 DeepSeek 思考");
    }

    @Test
    @DisplayName("供应商不收 16384（说的是上限太大）：降到 8192 再来一次、拿到回答；4096 那档用不上就不发")
    void 不收就降一档() throws Exception {
        String url = fake(body -> body.path("max_tokens").asInt() > 8192
                ? new String[]{"400", "{\"error\":{\"message\":\"max_tokens is too large: 16384. This model supports at most 8192 completion tokens\"}}", "application/json"}
                : sse("写好了"));
        ModelStreamResult result = new OpenAiChatCompatibleAdapter().stream(request(config(url, "some-8k-model"), "OFF"), e -> { });
        assertEquals("写好了", result.content());
        assertEquals(List.of(16_384, 8_192), bodies.stream().map(b -> b.path("max_tokens").asInt()).toList());
    }

    @Test
    @DisplayName("不是在说上限的 400（比如 key 不对）：不重来，原样说出来")
    void 别的错误不重来() throws Exception {
        String url = fake(body -> new String[]{"400", "{\"error\":{\"message\":\"invalid model name\"}}", "application/json"});
        assertThrows(BusinessException.class,
                () -> new OpenAiChatCompatibleAdapter().stream(request(config(url, "nope"), "OFF"), e -> { }));
        assertEquals(1, bodies.size(), "不是在说上限，却换着上限重试了");
    }

    @Test
    @DisplayName("说的是「这个参数不认」（o 系列要 max_completion_tokens）：不是上限太大，不降着重试（第五十八轮 review：原来白发两趟）")
    void 参数不认不重试() throws Exception {
        String url = fake(body -> new String[]{"400", "{\"error\":{\"message\":\"Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.\",\"type\":\"invalid_request_error\",\"param\":\"max_tokens\",\"code\":\"unsupported_parameter\"}}", "application/json"});
        assertThrows(BusinessException.class,
                () -> new OpenAiChatCompatibleAdapter().stream(request(config(url, "o3-mini"), "OFF"), e -> { }));
        assertEquals(1, bodies.size(), "参数不认却换着上限重试了");
        assertTrue(OutputLimits.rejectsMaxTokens(400, "max_tokens is too large: 16384. This model supports at most 8192 completion tokens"), "真在说上限太大的还得认");
    }

    @Test
    @DisplayName("Anthropic 那边同一套：16384，不收就降")
    void anthropic同一套() throws Exception {
        String url = fake(body -> body.path("max_tokens").asInt() > 8192
                ? new String[]{"400", "{\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"max_tokens: 16384 > 8192, which is the maximum allowed\"}}", "application/json"}
                : new String[]{"200", "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"嗯\"}}\n\n"
                        + "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n"
                        + "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n", "text/event-stream"});
        AiModelConfig c = new AiModelConfig();
        c.setProviderType("ANTHROPIC");
        c.setApiUrl(url);
        c.setModelName("claude-old");
        ModelStreamResult result = new AnthropicMessagesAdapter().stream(request(c, "OFF"), e -> { });
        assertEquals("嗯", result.content());
        assertEquals(List.of(16_384, 8_192), bodies.stream().map(b -> b.path("max_tokens").asInt()).toList());
        assertTrue(bodies.stream().allMatch(b -> b.path("stream").asBoolean()));
    }
}
