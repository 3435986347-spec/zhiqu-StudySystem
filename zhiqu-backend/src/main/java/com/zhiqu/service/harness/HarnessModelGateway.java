package com.zhiqu.service.harness;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.AiModelConfig;
import com.zhiqu.entity.HarnessUsage;
import com.zhiqu.mapper.HarnessUsageMapper;
import com.zhiqu.service.AiService;
import com.zhiqu.service.ai.AnthropicFormat;
import com.zhiqu.service.ai.ModelProviderClient;
import com.zhiqu.service.ai.ToolStreamAccumulator;
import com.zhiqu.service.ai.stream.AiStreamAdapterSupport;
import com.zhiqu.service.ai.stream.ModelStreamAdapterFactory;
import com.zhiqu.service.ai.stream.ModelStreamRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.client.RestTemplate;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 模型网关：命令行把整段对话和工具声明交过来，这里替它调模型、把增量原样流回去。
 *
 * <p>API Key 只在服务器上 —— 命令行拿不到、也不需要拿到。网关不跑工具、不改对话：
 * 循环在客户端，这里只做四件事：
 * <ol>
 *   <li><b>协议翻译</b>：OpenAI 兼容与 Anthropic 两种工具协议，对命令行都是同一种格式（{@link AnthropicFormat}）。</li>
 *   <li><b>按上下文窗口裁剪</b>：最后一道保险（{@link HarnessContext}），裁了多少在 {@code start} 事件里说。</li>
 *   <li><b>进度</b>：正文增量、工具名、工具参数长度都实时转出去 —— 模型写大文件时不会是一段沉默。</li>
 *   <li><b>计量</b>：每次调用记一行 {@code harness_usage}；供应商不报就估，并标 {@code estimated}。</li>
 * </ol>
 *
 * <h2>单次输出上限的回退</h2>
 *
 * <p>写一整个文件需要大的输出上限（默认 16384），但有的供应商上限更小，超了直接 400。
 * 这时按 8192 → 4096 再试 —— 只在还没有任何输出时重试（400 本来就发生在流开始之前）。
 */
@Service
public class HarnessModelGateway {
    private static final Logger log = LoggerFactory.getLogger(HarnessModelGateway.class);

    static final int DEFAULT_MAX_TOKENS = 16_384;
    static final int MAX_MAX_TOKENS = 32_000;
    static final int MAX_MESSAGES = 4_000;
    static final int MAX_TOTAL_CHARS = 8_000_000;
    static final int MAX_TOOLS = 256;
    /** 工具参数进度最多隔这么多字报一次。 */
    static final int PROGRESS_STEP_CHARS = 2_048;
    private static final Set<String> ROLES = Set.of("system", "user", "assistant", "tool");

    public interface Sink {
        void event(String name, Map<String, Object> data) throws IOException;
    }

    /** 客户端断开：不再往回发，也不再读上游。 */
    public static final class ClientGone extends RuntimeException {
        ClientGone(Throwable cause) {
            super(cause);
        }
    }

    private final AiService aiService;
    private final ModelProviderClient provider;
    private final ModelStreamAdapterFactory adapters;
    private final HarnessUsageMapper usageMapper;
    private final ObjectMapper json;
    private final String anthropicVersion;
    private final RestTemplate restTemplate;

    public HarnessModelGateway(AiService aiService, ModelProviderClient provider, ModelStreamAdapterFactory adapters,
                               HarnessUsageMapper usageMapper, ObjectMapper json,
                               @Value("${app.ai.anthropic-version:2023-06-01}") String anthropicVersion) {
        this.aiService = aiService;
        this.provider = provider;
        this.adapters = adapters;
        this.usageMapper = usageMapper;
        this.json = json;
        this.anthropicVersion = anthropicVersion;
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(10_000);
        // 两次读之间最多等 3 分钟：推理模型在第一个字之前可能要想很久
        factory.setReadTimeout(180_000);
        this.restTemplate = new RestTemplate(factory);
    }

    /** 请求体校验 + 规整。纯函数，判据直接喂。 */
    @SuppressWarnings("unchecked")
    static List<Map<String, Object>> validMessages(Object raw) {
        if (!(raw instanceof List<?> list) || list.isEmpty()) {
            throw new BusinessException("messages 不能为空");
        }
        if (list.size() > MAX_MESSAGES) {
            throw new BusinessException("对话太长（" + list.size() + " 条），请先压缩（/compact）");
        }
        List<Map<String, Object>> out = new ArrayList<>();
        long chars = 0;
        for (Object item : list) {
            if (!(item instanceof Map<?, ?> m)) {
                throw new BusinessException("messages 里每一项都要是对象");
            }
            String role = String.valueOf(m.get("role"));
            if (!ROLES.contains(role)) {
                throw new BusinessException("不认识的消息角色：" + role);
            }
            Object content = m.get("content");
            chars += content == null ? 0 : String.valueOf(content).length();
            Object calls = m.get("tool_calls");
            chars += calls == null ? 0 : String.valueOf(calls).length();
            out.add(new LinkedHashMap<>((Map<String, Object>) m));
        }
        if (chars > MAX_TOTAL_CHARS) {
            throw new BusinessException("对话内容太大，请先压缩（/compact）");
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    static List<Map<String, Object>> validTools(Object raw) {
        if (raw == null) return List.of();
        if (!(raw instanceof List<?> list)) {
            throw new BusinessException("tools 必须是数组");
        }
        if (list.size() > MAX_TOOLS) {
            throw new BusinessException("工具太多（" + list.size() + " 个）");
        }
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object item : list) {
            if (!(item instanceof Map<?, ?> m) || !(m.get("function") instanceof Map<?, ?>)) {
                throw new BusinessException("tools 里每一项都要是 {type:function, function:{name, parameters}}");
            }
            out.add((Map<String, Object>) m);
        }
        return out;
    }

    /** 输出上限：客户端要多少给多少，但不超过硬上限、也不超过窗口的一半（要给输入留地方）。 */
    static int maxTokens(Object requested, int window) {
        int want = requested instanceof Number n ? n.intValue() : DEFAULT_MAX_TOKENS;
        want = Math.max(256, Math.min(want, MAX_MAX_TOKENS));
        return Math.max(256, Math.min(want, window / 2));
    }

    /** 回退的几档：从要的那档往下，8192、4096。 */
    static List<Integer> fallbackLimits(int maxTokens) {
        List<Integer> out = new ArrayList<>();
        out.add(maxTokens);
        for (int step : new int[]{8_192, 4_096}) {
            if (step < out.get(out.size() - 1)) out.add(step);
        }
        return out;
    }

    /** 这个 400 是不是在说「输出上限太大」。 */
    static boolean rejectsMaxTokens(int status, String body) {
        if (status != 400 && status != 422) return false;
        String b = body == null ? "" : body.toLowerCase(Locale.ROOT);
        return b.contains("max_tokens") || b.contains("max_output_tokens") || b.contains("max_completion_tokens")
                || b.contains("maximum") && b.contains("token");
    }

    public void stream(Long userId, Map<String, Object> body, Sink sink) {
        List<Map<String, Object>> messages = validMessages(body.get("messages"));
        List<Map<String, Object>> tools = validTools(body.get("tools"));
        Long modelId = body.get("modelId") instanceof Number n ? n.longValue() : null;
        AiModelConfig config = aiService.resolveModel(userId, modelId);
        String type = provider.normalizeProviderType(config.getProviderType());
        if (!tools.isEmpty() && !provider.supportsToolCalling(config)) {
            throw new BusinessException("模型「" + label(config) + "」不支持工具调用，命令行读写文件、跑命令都靠它。"
                    + "请用 /model 换一个 OpenAI 兼容或 Anthropic 的模型");
        }
        int window = HarnessContext.effectiveWindow(config.getContextWindowTokens());
        int maxTokens = maxTokens(body.get("maxTokens"), window);
        HarnessContext.Trimmed trimmed = HarnessContext.trim(messages,
                window - maxTokens - HarnessContext.SAFETY_TOKENS);

        Map<String, Object> start = new LinkedHashMap<>();
        Map<String, Object> model = new LinkedHashMap<>();
        model.put("id", config.getId());
        model.put("label", label(config));
        model.put("modelName", config.getModelName());
        model.put("providerType", type);
        start.put("model", model);
        start.put("contextWindow", window);
        start.put("maxTokens", maxTokens);
        start.put("estimatedPromptTokens", trimmed.estimatedTokens());
        start.put("droppedMessages", trimmed.droppedMessages());
        start.put("elidedToolOutputs", trimmed.elidedToolOutputs());
        send(sink, "start", start);

        ToolStreamAccumulator acc = new ToolStreamAccumulator(new Forwarder(sink));
        int usedMaxTokens = maxTokens;
        RuntimeException last = null;
        for (int limit : fallbackLimits(maxTokens)) {
            try {
                usedMaxTokens = limit;
                call(config, type, trimmed.messages(), tools, limit, acc);
                last = null;
                break;
            } catch (RestClientResponseException e) {
                String detail = provider.extractAiErrorDetail(e.getResponseBodyAsString());
                if (rejectsMaxTokens(e.getStatusCode().value(), e.getResponseBodyAsString()) && acc.outputChars() == 0) {
                    log.info("模型拒绝了输出上限 {}，降一档重试：{}", limit, detail);
                    last = new BusinessException("模型拒绝了输出上限：" + detail);
                    continue;
                }
                throw new BusinessException("AI 接口调用失败（HTTP " + e.getStatusCode().value() + "）：" + detail);
            }
        }
        if (last != null) {
            throw last;
        }

        boolean estimated = acc.promptTokens() == null || acc.completionTokens() == null;
        int promptTokens = acc.promptTokens() != null ? acc.promptTokens() : trimmed.estimatedTokens();
        int completionTokens = acc.completionTokens() != null ? acc.completionTokens()
                : HarnessContext.estimateTokens(acc.text()) + (int) Math.ceil((acc.outputChars() - acc.text().length()) / 3.5);
        recordUsage(userId, config, promptTokens, completionTokens, estimated, acc.finishReason());

        Map<String, Object> usage = new LinkedHashMap<>();
        usage.put("promptTokens", promptTokens);
        usage.put("completionTokens", completionTokens);
        usage.put("estimated", estimated);
        Map<String, Object> done = new LinkedHashMap<>();
        done.put("message", acc.message());
        done.put("finishReason", acc.finishReason());
        done.put("maxTokens", usedMaxTokens);
        done.put("usage", usage);
        send(sink, "done", done);
    }

    private static String label(AiModelConfig config) {
        String name = config.getDisplayName() == null || config.getDisplayName().isBlank()
                ? config.getModelName() : config.getDisplayName();
        return name == null ? "未命名模型" : name;
    }

    private void call(AiModelConfig config, String type, List<Map<String, Object>> messages,
                      List<Map<String, Object>> tools, int maxTokens, ToolStreamAccumulator acc) {
        // SSRF：API URL 是用户自己填的。与其它出站请求一样，校验放在真正发请求的这一层
        provider.validateProviderRequestUrl(config.getApiUrl());
        if ("ANTHROPIC".equals(type)) {
            streamAnthropic(config, messages, tools, maxTokens, acc);
        } else if ("OPENAI_COMPATIBLE".equals(type) || "VLLM_OPENAI_COMPATIBLE".equals(type) || "OLLAMA".equals(type)) {
            streamOpenAi(config, messages, tools, maxTokens, acc);
        } else {
            // 其余协议（Gemini、Responses…）只走纯文本：上面已经保证了这里 tools 为空
            adapters.getAdapter(type).stream(
                    new ModelStreamRequest(config, provider.decryptedApiKey(config), messages, "OFF", anthropicVersion),
                    event -> {
                        if ("message.delta".equals(event.type())) acc.onPlainText(event.text());
                    });
        }
    }

    private void streamOpenAi(AiModelConfig config, List<Map<String, Object>> messages,
                              List<Map<String, Object>> tools, int maxTokens, ToolStreamAccumulator acc) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", config.getModelName());
        body.put("messages", messages);
        body.put("max_tokens", maxTokens);
        body.put("stream", true);
        if (!tools.isEmpty()) {
            body.put("tools", tools);
            body.put("tool_choice", "auto");
        }
        provider.applyTemperature(body);
        AiStreamAdapterSupport.applyOpenAiReasoningOptions(config, body, "OFF");
        String apiKey = provider.decryptedApiKey(config);
        restTemplate.execute(provider.resolveChatCompletionsUrl(config.getApiUrl()), HttpMethod.POST, request -> {
            request.getHeaders().setContentType(MediaType.APPLICATION_JSON);
            if (apiKey != null && !apiKey.isBlank()) {
                request.getHeaders().setBearerAuth(apiKey);
            }
            json.writeValue(request.getBody(), body);
        }, response -> {
            readSse(response.getBody(), acc::onOpenAiChunk);
            return null;
        });
    }

    private void streamAnthropic(AiModelConfig config, List<Map<String, Object>> messages,
                                 List<Map<String, Object>> tools, int maxTokens, ToolStreamAccumulator acc) {
        AnthropicFormat.Request converted = AnthropicFormat.fromOpenAi(messages, json);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", config.getModelName());
        body.put("max_tokens", maxTokens);
        if (!converted.system().isBlank()) {
            body.put("system", converted.system());
        }
        body.put("messages", converted.messages());
        if (!tools.isEmpty()) {
            body.put("tools", provider.toAnthropicTools(tools));
            body.put("tool_choice", Map.of("type", "auto"));
        }
        body.put("stream", true);
        provider.applyTemperature(body);
        restTemplate.execute(provider.resolveAnthropicMessagesUrl(config.getApiUrl()), HttpMethod.POST, request -> {
            request.getHeaders().putAll(provider.anthropicHeaders(config));
            json.writeValue(request.getBody(), body);
        }, response -> {
            readSse(response.getBody(), acc::onAnthropicEvent);
            return null;
        });
    }

    private void readSse(java.io.InputStream in, java.util.function.Consumer<JsonNode> onData) throws IOException {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (!line.startsWith("data:")) continue;
                String data = line.substring(5).trim();
                if (data.isEmpty() || "[DONE]".equals(data)) continue;
                onData.accept(json.readTree(data));
            }
        }
    }

    private void recordUsage(Long userId, AiModelConfig config, int prompt, int completion, boolean estimated, String finish) {
        try {
            HarnessUsage row = new HarnessUsage();
            row.setUserId(userId);
            row.setModelConfigId(config.getId());
            row.setModelName(config.getModelName());
            row.setPromptTokens(prompt);
            row.setCompletionTokens(completion);
            row.setEstimated(estimated ? 1 : 0);
            row.setFinishReason(finish);
            row.setCreatedAt(LocalDateTime.now());
            usageMapper.insert(row);
        } catch (Exception e) {
            // 计量失败不能让已经拿到的回答作废
            log.warn("记录命令行用量失败 userId={} err={}", userId, e.getMessage());
        }
    }

    private static void send(Sink sink, String name, Map<String, Object> data) {
        try {
            sink.event(name, data);
        } catch (IOException e) {
            throw new ClientGone(e);
        }
    }

    /** 把累加器的事件转给客户端；工具参数的进度按字数节流。 */
    private static final class Forwarder implements ToolStreamAccumulator.Listener {
        private final Sink sink;
        private final Map<Integer, Integer> lastReported = new LinkedHashMap<>();

        Forwarder(Sink sink) {
            this.sink = sink;
        }

        @Override
        public void onText(String delta) {
            send(sink, "delta", Map.of("text", delta));
        }

        @Override
        public void onReasoning(String delta) {
            send(sink, "reasoning", Map.of("text", delta));
        }

        @Override
        public void onToolStart(int index, String id, String name) {
            Map<String, Object> data = new LinkedHashMap<>();
            data.put("index", index);
            data.put("id", id);
            data.put("name", name);
            send(sink, "tool_call", data);
        }

        @Override
        public void onToolArgs(int index, int totalChars) {
            int last = lastReported.getOrDefault(index, 0);
            if (totalChars - last >= PROGRESS_STEP_CHARS) {
                lastReported.put(index, totalChars);
                send(sink, "tool_progress", Map.of("index", index, "chars", totalChars));
            }
        }
    }
}
