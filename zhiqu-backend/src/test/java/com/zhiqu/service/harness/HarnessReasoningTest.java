package com.zhiqu.service.harness;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import com.zhiqu.entity.AiModelConfig;
import com.zhiqu.mapper.HarnessUsageMapper;
import com.zhiqu.service.AiService;
import com.zhiqu.service.ai.ModelProviderClient;
import com.zhiqu.service.ai.stream.AiStreamAdapterSupport;
import com.zhiqu.service.ai.stream.ModelStreamAdapterFactory;
import com.zhiqu.service.ai.stream.ReasoningEffort;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

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
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 思考档位（第一百零八轮，Codex 同级第 1 步，用户 2026-11-07：instant / medium / high / extra / max）。真的 HTTP：本机起假模型，
 * 按 DeepSeek 文档和 Anthropic 文档的格式回；断言落在「供应商收到了什么」「命令行收到了什么」。
 * DeepSeek 的规矩来自官方文档（Thinking Mode）：带工具时之前每一轮的 reasoning_content 都要传回去，缺了 400。
 */
class HarnessReasoningTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private HttpServer server;
    private final List<JsonNode> requests = Collections.synchronizedList(new ArrayList<>());
    private final AiService aiService = mock(AiService.class);
    private String defaultReasoning = "off";
    private final Map<String, Map<String, Object>> last = new LinkedHashMap<>();
    private final List<String> events = new ArrayList<>();

    @AfterEach
    void stop() {
        if (server != null) server.stop(0);
    }

    private String fakeModel(Function<JsonNode, Object[]> handler) throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", ex -> {
            JsonNode body = JSON.readTree(ex.getRequestBody().readAllBytes());
            requests.add(body);
            Object[] reply = handler.apply(body);
            byte[] bytes = ((String) reply[1]).getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().add("Content-Type", (int) reply[0] == 200 ? "text/event-stream" : "application/json");
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

    private static final String OPENAI_REPLY = sse(
            "{\"choices\":[{\"delta\":{\"reasoning_content\":\"先想\"}}]}",
            "{\"choices\":[{\"delta\":{\"reasoning_content\":\"一下\"}}]}",
            "{\"choices\":[{\"delta\":{\"content\":\"好\"},\"finish_reason\":\"stop\"}]}",
            "[DONE]");

    private HarnessModelGateway gateway() {
        SensitiveCryptoService crypto = mock(SensitiveCryptoService.class);
        when(crypto.decrypt(any())).thenReturn("sk-test");
        ModelProviderClient provider = new ModelProviderClient(JSON, crypto, "2023-06-01", "");
        return new HarnessModelGateway(aiService, provider, new ModelStreamAdapterFactory(List.of()), mock(HarnessUsageMapper.class), JSON, "2023-06-01", "0", defaultReasoning);
    }

    private void model(String type, String url, String name) {
        AiModelConfig c = new AiModelConfig();
        c.setId(7L);
        c.setProviderType(type);
        c.setApiUrl(url);
        c.setModelName(name);
        c.setDisplayName("假模型");
        c.setEncryptedApiKey("enc");
        c.setEnabled(1);
        when(aiService.resolveModel(anyLong(), any())).thenReturn(c);
    }

    private static final List<Map<String, Object>> TOOLS = List.of(Map.of("type", "function",
            "function", Map.of("name", "write_file", "parameters", Map.of("type", "object"))));

    /** 一段有三轮助手回复的历史：DeepSeek 自己想的、关着档位时生成的、别的模型想的。 */
    private static List<Map<String, Object>> history(String modelName) {
        List<Map<String, Object>> m = new ArrayList<>();
        m.add(Map.of("role", "user", "content", "第一句"));
        m.add(Map.of("role", "assistant", "content", "甲", "reasoning_content", "想过的", "reasoning_model", modelName));
        m.add(Map.of("role", "user", "content", "第二句"));
        m.add(Map.of("role", "assistant", "content", "乙"));
        m.add(Map.of("role", "user", "content", "第三句"));
        m.add(Map.of("role", "assistant", "content", "丙", "reasoning_content", "别的模型想的", "reasoning_model", "另一个模型"));
        m.add(Map.of("role", "user", "content", "第四句"));
        return m;
    }

    private Map<String, Object> body(List<Map<String, Object>> messages, String reasoning) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("messages", messages);
        b.put("tools", TOOLS);
        if (reasoning != null) b.put("reasoning", reasoning);
        return b;
    }

    private HarnessModelGateway.Sink sink() {
        return (name, data) -> {
            events.add(name);
            last.put(name, data);
        };
    }

    @Test
    @DisplayName("五档各是什么：instant = OFF、认不出 = OFF，老的 AUTO / DEEP 还认")
    void 五档() {
        assertEquals("OFF", ReasoningEffort.normalize("instant"));
        assertEquals("OFF", ReasoningEffort.normalize("ultra"));
        assertEquals("OFF", ReasoningEffort.normalize(null));
        assertEquals("MEDIUM", ReasoningEffort.normalize("medium"));
        assertEquals("HIGH", ReasoningEffort.normalize(" High "));
        assertEquals("EXTRA", ReasoningEffort.normalize("extra"));
        assertEquals("MAX", ReasoningEffort.normalize("MAX"));
        assertEquals("MEDIUM", ReasoningEffort.normalize("AUTO"));
        assertEquals("HIGH", ReasoningEffort.normalize("DEEP"));
        assertFalse(ReasoningEffort.on("instant"));
        assertTrue(ReasoningEffort.on("extra"));
        assertEquals("instant", ReasoningEffort.cliName("OFF"));
        assertEquals("extra", ReasoningEffort.cliName("EXTRA"));
    }

    @Test
    @DisplayName("各家的词：DeepSeek 只有 low / high / max（extra 和 high 一样）；gpt-5 最高 xhigh、更新的有 max；中转的 Claude；不认识的模型什么都不发")
    void 各家的词() {
        Map<String, String> deepseek = Map.of("MEDIUM", "low", "HIGH", "high", "EXTRA", "high", "MAX", "max");
        deepseek.forEach((mode, word) -> {
            Map<String, Object> b = new LinkedHashMap<>();
            AiStreamAdapterSupport.applyOpenAiReasoningOptions(config("deepseek-v4-pro"), b, mode);
            assertEquals(word, b.get("reasoning_effort"), mode);
            assertEquals(Map.of("type", "enabled"), b.get("thinking"), mode);
        });
        Map<String, Object> off = new LinkedHashMap<>();
        AiStreamAdapterSupport.applyOpenAiReasoningOptions(config("deepseek-v4-pro"), off, "OFF");
        assertEquals(Map.of("type", "disabled"), off.get("thinking"));
        assertNull(off.get("reasoning_effort"));

        assertEquals("xhigh", effortFor("gpt-5.5", "MAX"));
        assertEquals("max", effortFor("gpt-6.1-sol", "MAX"));
        assertEquals("xhigh", effortFor("o3-mini", "EXTRA"));
        assertEquals("medium", effortFor("openai/gpt-5.5", "MEDIUM"));
        assertEquals("high", effortFor("claude-opus-5-5", "HIGH"));
        assertNull(effortFor("qwen3-coder", "HIGH"), "不认识的模型不发，照它自己的默认");
        assertNull(effortFor("gpt-5.5", "OFF"));

        Map<String, Object> claude = new LinkedHashMap<>();
        AiStreamAdapterSupport.applyAnthropicThinking(claude, "EXTRA", "claude-opus-5-5");
        assertEquals(Map.of("type", "adaptive"), claude.get("thinking"));
        assertEquals(Map.of("effort", "xhigh"), claude.get("output_config"));
        Map<String, Object> old = new LinkedHashMap<>();
        AiStreamAdapterSupport.applyAnthropicThinking(old, "MAX", "claude-3-7-sonnet");
        assertEquals(Map.of("type", "enabled", "budget_tokens", 8192), old.get("thinking"));
        Map<String, Object> none = new LinkedHashMap<>();
        AiStreamAdapterSupport.applyAnthropicThinking(none, "OFF", "claude-opus-5-5");
        assertTrue(none.isEmpty(), "Opus 5.5 的思考关不掉（disabled 是 400），instant 什么都不发");
    }

    private static AiModelConfig config(String name) {
        AiModelConfig c = new AiModelConfig();
        c.setModelName(name);
        return c;
    }

    private static Object effortFor(String name, String mode) {
        Map<String, Object> b = new LinkedHashMap<>();
        AiStreamAdapterSupport.applyOpenAiReasoningOptions(config(name), b, mode);
        return b.get("reasoning_effort");
    }

    @Test
    @DisplayName("DeepSeek 开思考：每条助手消息都带 reasoning_content —— 自己想的给原文，关着档位时的、别的模型想的给空串（缺了官方文档说 400）；网关自己的字段不外传")
    void deepSeek回传() throws Exception {
        String url = fakeModel(b -> new Object[]{200, OPENAI_REPLY});
        model("OPENAI_COMPATIBLE", url, "deepseek-v4-pro");
        gateway().stream(1L, body(history("deepseek-v4-pro"), "high"), sink());
        JsonNode sent = requests.get(0);
        assertEquals("enabled", sent.path("thinking").path("type").asText(), sent.toString());
        assertEquals("high", sent.path("reasoning_effort").asText());
        JsonNode m = sent.path("messages");
        assertEquals("想过的", m.path(1).path("reasoning_content").asText());
        assertTrue(m.path(3).has("reasoning_content"), "关着档位时生成的那条缺了字段：DeepSeek 会 400");
        assertEquals("", m.path(3).path("reasoning_content").asText());
        assertEquals("", m.path(5).path("reasoning_content").asText(), "别的模型想的不该传给这个模型");
        assertFalse(m.path(0).has("reasoning_content"), "用户那条不该带");
        for (JsonNode one : m) assertFalse(one.has("reasoning_model") || one.has("reasoning_blocks"), one.toString());
    }

    @Test
    @DisplayName("回来的思考挂在 done 的消息上，命令行原样记着、下一轮带回来；还说是哪个模型想的")
    @SuppressWarnings("unchecked")
    void 回来的思考() throws Exception {
        String url = fakeModel(b -> new Object[]{200, OPENAI_REPLY});
        model("OPENAI_COMPATIBLE", url, "deepseek-v4-pro");
        gateway().stream(1L, body(List.of(Map.of("role", "user", "content", "问")), "high"), sink());
        Map<String, Object> msg = (Map<String, Object>) last.get("done").get("message");
        assertEquals("先想一下", msg.get("reasoning_content"));
        assertEquals("deepseek-v4-pro", msg.get("reasoning_model"));
        assertEquals("好", msg.get("content"));
        assertTrue(events.contains("reasoning"), "思考要转给命令行（它据此说「思考中」）");
    }

    @Test
    @DisplayName("没开思考：DeepSeek 明说 disabled、历史里的思考不带；回包没有思考就不挂这几个字段")
    @SuppressWarnings("unchecked")
    void 关着() throws Exception {
        String url = fakeModel(b -> new Object[]{200, sse("{\"choices\":[{\"delta\":{\"content\":\"好\"},\"finish_reason\":\"stop\"}]}", "[DONE]")});
        model("OPENAI_COMPATIBLE", url, "deepseek-v4-pro");
        gateway().stream(1L, body(history("deepseek-v4-pro"), "instant"), sink());
        JsonNode sent = requests.get(0);
        assertEquals("disabled", sent.path("thinking").path("type").asText());
        assertFalse(sent.has("reasoning_effort"));
        for (JsonNode one : sent.path("messages")) assertFalse(one.has("reasoning_content"), one.toString());
        Map<String, Object> msg = (Map<String, Object>) last.get("done").get("message");
        assertFalse(msg.containsKey("reasoning_content") || msg.containsKey("reasoning_model"), msg.toString());
    }

    @Test
    @DisplayName("别的供应商一个字段都见不到：不认识的字段有的会报错")
    void 别的供应商() throws Exception {
        String url = fakeModel(b -> new Object[]{200, OPENAI_REPLY});
        model("OPENAI_COMPATIBLE", url, "qwen3-coder");
        gateway().stream(1L, body(history("qwen3-coder"), "high"), sink());
        JsonNode sent = requests.get(0);
        assertFalse(sent.has("thinking") || sent.has("reasoning_effort"), sent.toString());
        for (JsonNode one : sent.path("messages")) {
            assertFalse(one.has("reasoning_content") || one.has("reasoning_model") || one.has("reasoning_blocks"), one.toString());
        }
    }

    @Test
    @DisplayName("请求没说听服务端的默认（app.ai.harness-reasoning）；说了听请求的，instant 也算说了；认不出就当 instant；默认 off 不是坏值")
    void 默认值() throws Exception {
        String url = fakeModel(b -> new Object[]{200, OPENAI_REPLY});
        model("OPENAI_COMPATIBLE", url, "deepseek-v4-pro");
        List<Map<String, Object>> ask = List.of(Map.of("role", "user", "content", "问"));

        defaultReasoning = "high";
        gateway().stream(1L, body(ask, null), sink());
        assertEquals("enabled", requests.get(0).path("thinking").path("type").asText(), "没说就听默认");

        gateway().stream(1L, body(ask, "instant"), sink());
        assertEquals("disabled", requests.get(1).path("thinking").path("type").asText(), "说了 instant 就是不思考");

        gateway().stream(1L, body(ask, "ultra"), sink());
        assertEquals("disabled", requests.get(2).path("thinking").path("type").asText(), "认不出的当 instant，不把请求弄坏");

        defaultReasoning = "off";
        gateway().stream(1L, body(ask, null), sink());
        assertEquals("disabled", requests.get(3).path("thinking").path("type").asText(), "默认 off：第十二、五十四轮关思考的理由还在，量过再改");
    }

    @Test
    @DisplayName("思考也算在输出上限里：开着时翻倍（不超过上限和半个窗口），关着不变；第五十四轮 DeepSeek 想完 4096 就没地方写回答")
    void 输出上限() throws Exception {
        String url = fakeModel(b -> new Object[]{200, OPENAI_REPLY});
        model("OPENAI_COMPATIBLE", url, "deepseek-v4-pro");
        Map<String, Object> on = body(List.of(Map.of("role", "user", "content", "问")), "high");
        on.put("maxTokens", 16384);
        gateway().stream(1L, on, sink());
        assertEquals(32000, requests.get(0).path("max_tokens").asInt(), "16384 翻倍，封顶 32000");
        Map<String, Object> off = body(List.of(Map.of("role", "user", "content", "问")), "instant");
        off.put("maxTokens", 16384);
        gateway().stream(1L, off, sink());
        assertEquals(16384, requests.get(1).path("max_tokens").asInt());
        assertEquals(40000, ReasoningHistory.outputLimit(40000, "HIGH", 32000, 1_000_000), "已经比封顶大就不缩");
        assertEquals(10000, ReasoningHistory.outputLimit(8192, "HIGH", 32000, 20000), "不超过半个窗口");
    }

    @Test
    @DisplayName("供应商不收思考参数（400 提到它）：关掉重试一次拿到回答，并记住 —— 下一次直接不发，不再挨这个 400")
    void 不收就降() throws Exception {
        String url = fakeModel(b -> b.has("reasoning_effort")
                ? new Object[]{400, "{\"error\":{\"message\":\"Unknown parameter: reasoning_effort\"}}"}
                : new Object[]{200, OPENAI_REPLY});
        model("OPENAI_COMPATIBLE", url, "gpt-5.5");
        HarnessModelGateway gw = gateway();
        List<Map<String, Object>> ask = List.of(Map.of("role", "user", "content", "问"));
        gw.stream(1L, body(ask, "high"), sink());
        assertEquals(2, requests.size());
        assertTrue(requests.get(0).has("reasoning_effort"));
        assertFalse(requests.get(1).has("reasoning_effort"));
        assertTrue(events.contains("done"));
        gw.stream(1L, body(ask, "high"), sink());
        assertEquals(3, requests.size(), "记住了就不再先挨一个 400");
        assertFalse(requests.get(2).has("reasoning_effort"));
    }

    @Test
    @DisplayName("Anthropic：思考块带签名原样收下，下一轮原样放在最前面；档位走 output_config.effort；instant 什么都不发")
    @SuppressWarnings("unchecked")
    void anthropic回放() throws Exception {
        String reply = sse(
                "{\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":9}}}",
                "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"\"}}",
                "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"想\"}}",
                "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"sig-1\"}}",
                "{\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"redacted_thinking\",\"data\":\"密文\"}}",
                "{\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}",
                "{\"type\":\"content_block_delta\",\"index\":2,\"delta\":{\"type\":\"text_delta\",\"text\":\"好\"}}",
                "{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}");
        String url = fakeModel(b -> new Object[]{200, reply});
        model("ANTHROPIC", url, "claude-opus-5-5");
        HarnessModelGateway gw = gateway();
        gw.stream(1L, body(new ArrayList<>(List.of(Map.of("role", "user", "content", "问"))), "high"), sink());
        assertEquals("high", requests.get(0).path("output_config").path("effort").asText());
        assertEquals("adaptive", requests.get(0).path("thinking").path("type").asText());
        Map<String, Object> msg = (Map<String, Object>) last.get("done").get("message");
        List<Map<String, Object>> blocks = (List<Map<String, Object>>) msg.get("reasoning_blocks");
        assertEquals(2, blocks.size());
        assertEquals("想", blocks.get(0).get("thinking"));
        assertEquals("sig-1", blocks.get(0).get("signature"), "没有签名回放就是 400");
        assertEquals("密文", blocks.get(1).get("data"));
        assertFalse(msg.containsKey("reasoning_content"), "思考块存过了，原文不再存一份");

        List<Map<String, Object>> next = new ArrayList<>();
        next.add(Map.of("role", "user", "content", "问"));
        next.add(msg);
        next.add(Map.of("role", "user", "content", "接着"));
        gw.stream(1L, body(next, "instant"), sink());
        JsonNode sent = requests.get(1);
        assertFalse(sent.has("output_config") || sent.has("thinking"), "instant 什么都不发（Opus 5.5 发 disabled 是 400）：" + sent);
        JsonNode content = sent.path("messages").path(1).path("content");
        assertEquals("thinking", content.path(0).path("type").asText(), content.toString());
        assertEquals("sig-1", content.path(0).path("signature").asText());
        assertEquals("redacted_thinking", content.path(1).path("type").asText());
        assertEquals("text", content.path(2).path("type").asText(), "思考块在最前面");
        assertFalse(sent.path("messages").path(1).has("reasoning_model"), "网关自己的字段不外传");
    }

    @Test
    @DisplayName("Anthropic：换了模型不回放（别的模型读不了）；回放被拒（历史改过、签名失效）去掉重试并记住；只有思考块时补一段文字")
    void anthropic不回放() throws Exception {
        String ok = sse("{\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":9}}}",
                "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}",
                "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"好\"}}",
                "{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}");
        String url = fakeModel(b -> b.toString().contains("\"signature\"")
                ? new Object[]{400, "{\"error\":{\"message\":\"messages.1: thinking block is invalid\"}}"}
                : new Object[]{200, ok});
        model("ANTHROPIC", url, "claude-opus-5-5");
        HarnessModelGateway gw = gateway();

        Map<String, Object> other = new LinkedHashMap<>(Map.of("role", "assistant", "content", "甲", "reasoning_model", "claude-sonnet-5-5",
                "reasoning_blocks", List.of(Map.of("type", "thinking", "thinking", "想", "signature", "s"))));
        gw.stream(1L, body(new ArrayList<>(List.of(Map.of("role", "user", "content", "问"), other, Map.of("role", "user", "content", "接着"))), null), sink());
        assertEquals(1, requests.size(), "别的模型想的不该带上");
        assertFalse(requests.get(0).toString().contains("signature"));

        Map<String, Object> mine = new LinkedHashMap<>(Map.of("role", "assistant", "content", "", "reasoning_model", "claude-opus-5-5",
                "reasoning_blocks", List.of(Map.of("type", "thinking", "thinking", "想", "signature", "s"))));
        List<Map<String, Object>> withMine = new ArrayList<>(List.of(Map.of("role", "user", "content", "问"), mine, Map.of("role", "user", "content", "接着")));
        gw.stream(1L, body(withMine, null), sink());
        assertEquals(3, requests.size(), "被拒一次、去掉重试一次");
        assertTrue(requests.get(1).toString().contains("signature"));
        assertEquals("thinking", requests.get(1).path("messages").path(1).path("content").path(0).path("type").asText());
        assertEquals("text", requests.get(1).path("messages").path(1).path("content").path(1).path("type").asText(), "只有思考块的消息要补一段文字");
        assertFalse(requests.get(2).toString().contains("signature"));
        assertTrue(events.contains("done"));
        gw.stream(1L, body(withMine, null), sink());
        assertEquals(4, requests.size(), "记住了：不再先挨一个 400");
        assertFalse(requests.get(3).toString().contains("signature"));
    }

    @Test
    @DisplayName("思考内容占窗口：裁剪时算进去")
    void 算进窗口() {
        int without = HarnessContext.estimateMessage(Map.of("role", "assistant", "content", "好"));
        int withText = HarnessContext.estimateMessage(Map.of("role", "assistant", "content", "好", "reasoning_content", "想".repeat(1000)));
        int withBlocks = HarnessContext.estimateMessage(Map.of("role", "assistant", "content", "好", "reasoning_blocks", List.of(Map.of("thinking", "想".repeat(1000)))));
        assertTrue(withText > without + 500, withText + " vs " + without);
        assertTrue(withBlocks > without + 500, withBlocks + " vs " + without);
    }

    @Test
    @DisplayName("哪些模型能思考：deepseek-v4-pro 算（原来比错了对象，选了档位整个请求报错）；认不出的不算")
    void 哪些模型能思考() {
        for (String name : List.of("deepseek-v4-pro", "DeepSeek-Reasoner", "claude-opus-5-5", "gpt-6.1-sol", "openrouter/o3-mini")) {
            assertTrue(ReasoningEffort.supported(null, name, "OPENAI_COMPATIBLE"), name);
        }
        for (String name : List.of("qwen3-coder", "gpt-4o", "o2-model")) {
            assertFalse(ReasoningEffort.supported(null, name, "OPENAI_COMPATIBLE"), name);
        }
        assertTrue(ReasoningEffort.supported(null, "某个代理名", "ANTHROPIC"), "Anthropic 协议都能思考");
        assertTrue(ReasoningEffort.supported("chat,thinking", "qwen3-coder", "OPENAI_COMPATIBLE"), "配置里写了能力就听配置");
    }

    @Test
    @DisplayName("网页的问答：选了档位、模型不能思考时当 instant（不报错）；档位交给代码模式")
    void 网页接上档位() throws Exception {
        String code = com.zhiqu.SourceText.stripComments(java.nio.file.Files.readString(
                java.nio.file.Path.of("src/main/java/com/zhiqu/service/impl/AiServiceImpl.java")));
        assertFalse(code.contains("不支持深度思考"), "选了档位不该让整个请求报错");
        String gate = "String normalizedReasoningMode = supportsDeepReasoning(config) ? normalizeReasoningMode(reasoningMode) : ReasoningEffort.OFF;";
        assertEquals(2, code.split(java.util.regex.Pattern.quote(gate), -1).length - 1, "同步和流式两条路都要这样判");
        assertTrue(code.matches("(?s).*codeWorkspaceAgent\\.run\\([^;]*s\\.reasoningMode,[^;]*;.*"), "代码模式没拿到档位");
    }

    @Test
    @DisplayName("发给 Anthropic 之前去掉只有网关认识的字段：AnthropicFormat 是按字段挑的会挡住，这里自己也要干净（挡住的那道换了写法就漏出去）")
    void anthropic不带内部字段() {
        Map<String, Object> m = Map.of("role", "assistant", "content", "甲", "reasoning_model", "m1",
                "reasoning_content", "想过", "reasoning_blocks", List.of(Map.of("type", "thinking")));
        Map<String, Object> same = ReasoningHistory.forAnthropic(List.of(m), "m1", true).get(0);
        assertEquals(java.util.Set.of("role", "content", "reasoning_blocks"), same.keySet());
        Map<String, Object> other = ReasoningHistory.forAnthropic(List.of(m), "m2", true).get(0);
        assertEquals(java.util.Set.of("role", "content"), other.keySet());
    }
}
