package com.zhiqu.service.ai.stream;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.AiModelConfig;
import com.zhiqu.service.ai.ProviderFailure;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.client.RestTemplate;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

@Slf4j
public final class AiStreamAdapterSupport {
    private AiStreamAdapterSupport() {
    }

    /** 两次读之间最多等多久。网页聊天没有「停止」按钮，所以不像命令行网关那样等 3 分钟。 */
    public static final int STREAM_READ_TIMEOUT_SECONDS = 60;
    /** 回的不是 SSE 时，最多留多少字去认它是什么（整段 JSON 回答、HTML 页面）。 */
    private static final int RAW_BODY_CAP = 1_000_000;

    /**
     * 一次流式读取的收尾情况（第十九轮）。原来流读完就算「说完了」：连接中途断开的半截回答照样标成完成，
     * 被输出上限截断、被内容审核拦下也一个字不说，地址填成官网（回一页 HTML）得到的是一条空白回答。
     */
    public static final class StreamEnd {
        int dataLines;
        boolean ended;
        String finishReason;
        String contentType = "";
        String rawBody = "";

        void finish(String reason) {
            ended = true;
            if (reason != null && !reason.isBlank()) {
                finishReason = normalizeFinish(reason);
            }
        }

        /** 调用方按自家协议认出了结束事件（Anthropic 的 message_stop）。 */
        public void markEnded() {
            ended = true;
        }

        /** 看到了结束信号（[DONE]、finish_reason、message_stop…）。 */
        public boolean ended() {
            return ended;
        }

        public int dataLines() {
            return dataLines;
        }

        /** 一行 data 都没有、回的也不是 SSE（网页、别的东西）：这时给出那句「地址可能填错了」，否则 null。 */
        public String notAStreamMessage() {
            if (dataLines > 0) {
                return null;
            }
            String type = contentType.toLowerCase(Locale.ROOT);
            if (type.contains("event-stream")) {
                return null;
            }
            String shown = type.isEmpty() ? "没有类型" : type.split(";")[0];
            return "接口返回的不是模型的流式回答（返回的是 " + shown
                    + "）：「接口地址」可能填错了，一般形如 https://…/v1/chat/completions";
        }
    }

    /** 连接断在半路：已经收到的那一截由调用方留着，并告诉用户没说完。 */
    public static final class StreamCutOff extends BusinessException {
        public StreamCutOff() {
            super("模型的回答没说完，连接就断了");
        }
    }

    @FunctionalInterface
    public interface SseHandler {
        void onData(String eventName, JsonNode root, StreamEnd end);
    }

    /** 各家的「为什么停」归成几种：stop / length（输出上限）/ filtered（内容审核）。 */
    static String normalizeFinish(String reason) {
        String r = reason.trim().toLowerCase(Locale.ROOT);
        return switch (r) {
            case "length", "max_tokens", "max_output_tokens" -> "length";
            case "content_filter", "safety", "refusal", "recitation", "prohibited_content", "blocklist", "spii" -> "filtered";
            case "stop", "end_turn", "stop_sequence", "tool_calls", "tool_use", "function_call", "finish_reason_unspecified" -> "stop";
            default -> r;
        };
    }

    /** 读一条 SSE 流：记下有几行 data、有没有 [DONE]、回的是什么类型；不是 SSE 的内容留一截给调用方认。 */
    public static StreamEnd readSse(ClientHttpResponse response, ObjectMapper mapper, SseHandler handler) throws IOException {
        StreamEnd end = new StreamEnd();
        MediaType type = response.getHeaders().getContentType();
        end.contentType = type == null ? "" : type.toString();
        StringBuilder raw = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(response.getBody(), StandardCharsets.UTF_8))) {
            String eventName = "";
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.startsWith("event:")) {
                    eventName = line.substring(6).trim();
                    continue;
                }
                if (!line.startsWith("data:")) {
                    if (end.dataLines == 0 && raw.length() < RAW_BODY_CAP) {
                        raw.append(line).append('\n');
                    }
                    continue;
                }
                String data = line.substring(5).trim();
                if (data.isBlank()) {
                    continue;
                }
                end.dataLines++;
                if ("[DONE]".equals(data)) {
                    end.ended = true;
                    continue;
                }
                handler.onData(eventName, mapper.readTree(data), end);
            }
        }
        end.rawBody = end.dataLines == 0 ? raw.toString() : "";
        return end;
    }

    /**
     * 流读完之后核对：一行 data 都没有且不是 SSE —— 回的是网页或别的东西；有内容却没有结束信号 —— 断在半路。
     * 空的 SSE（直接 [DONE]）不在这里判：「什么都没说」由调用方说，它知道这一轮还有没有别的产出。
     */
    static void requireComplete(StreamEnd end, boolean expectEndSignal) {
        String notAStream = end.notAStreamMessage();
        if (notAStream != null) {
            throw new BusinessException(notAStream);
        }
        if (end.dataLines > 0 && expectEndSignal && !end.ended) {
            throw new StreamCutOff();
        }
    }

    static BusinessException ioError(Exception e) {
        log.warn("模型流式调用失败：{}", e.toString());
        return new BusinessException(ProviderFailure.io(e, STREAM_READ_TIMEOUT_SECONDS));
    }

    static BusinessException inStreamError(JsonNode root, String apiKey) {
        return new BusinessException(ProviderFailure.inStream(root, apiKey));
    }

    static boolean hasText(String value) {
        return value != null && !value.trim().isEmpty();
    }

    /**
     * 流式增量专用：纯换行/空格的增量（如 "\n\n"）是合法内容，不能按 hasText 丢弃，
     * 否则模型逐段输出时所有段落换行都会蒸发，正文被压成一行。
     */
    static boolean hasContent(String value) {
        return value != null && !value.isEmpty();
    }

    static boolean isReasoningRequested(String mode) {
        String normalized = mode == null ? "OFF" : mode.trim().toUpperCase(Locale.ROOT);
        return "AUTO".equals(normalized) || "DEEP".equals(normalized);
    }

    /**
     * 按配置决定是否写入 temperature。
     * 新一代模型（如 Claude fable / opus-4 系列）已废弃 temperature，配置留空即不发送，
     * 避免 400 "temperature is deprecated for this model"；需要固定温度的老模型可在
     * app.ai.temperature 填数字。配置为空或非数字一律不发送。
     */
    static void applyTemperature(Map<String, Object> target, String configured) {
        if (!hasText(configured)) {
            return;
        }
        try {
            target.put("temperature", Double.parseDouble(configured.trim()));
        } catch (NumberFormatException ignored) {
            // 非数字视为不发送
        }
    }

    /**
     * 按模型代际选择 Anthropic 思考参数格式：
     *  - claude-2/claude-3 系（含 3.5/3.7）：旧格式 thinking:{type:enabled, budget_tokens}
     *  - 其余（fable / opus-4+ / sonnet-4+ / haiku-4+ 等新代）：thinking:{type:adaptive} + output_config.effort
     * 新代模型发旧格式会被拒（400 "thinking.type: enabled is not supported"），已由 fable-5 实测确认。
     */
    static void applyAnthropicThinking(Map<String, Object> body, String reasoningMode, String modelName) {
        if (!isReasoningRequested(reasoningMode)) {
            return;
        }
        String name = modelName == null ? "" : modelName.toLowerCase(Locale.ROOT);
        boolean deep = "DEEP".equalsIgnoreCase(reasoningMode);
        if (name.contains("claude-2") || name.contains("claude-3")) {
            body.put("thinking", Map.of("type", "enabled", "budget_tokens", deep ? 2048 : 1024));
        } else {
            body.put("thinking", Map.of("type", "adaptive"));
            body.put("output_config", Map.of("effort", deep ? "high" : "medium"));
        }
    }

    static RestTemplate timeoutRestTemplate() {
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(10_000);
        factory.setReadTimeout(STREAM_READ_TIMEOUT_SECONDS * 1000);
        return new RestTemplate(factory);
    }

    static String resolveChatCompletionsUrl(String apiUrl) {
        String url = hasText(apiUrl) ? apiUrl.trim() : "https://api.openai.com/v1/chat/completions";
        while (url.endsWith("/")) {
            url = url.substring(0, url.length() - 1);
        }
        if (url.endsWith("/chat/completions")) {
            return url;
        }
        if (url.contains("api.openai.com") && !url.endsWith("/v1")) {
            return url + "/v1/chat/completions";
        }
        return url + "/chat/completions";
    }

    static String resolveResponsesUrl(String apiUrl) {
        String url = hasText(apiUrl) ? apiUrl.trim() : "https://api.openai.com/v1/responses";
        while (url.endsWith("/")) {
            url = url.substring(0, url.length() - 1);
        }
        if (url.endsWith("/responses")) {
            return url;
        }
        if (url.endsWith("/v1")) {
            return url + "/responses";
        }
        return url + "/v1/responses";
    }

    static String resolveAnthropicMessagesUrl(String apiUrl) {
        String url = hasText(apiUrl) ? apiUrl.trim() : "https://api.anthropic.com/v1/messages";
        while (url.endsWith("/")) {
            url = url.substring(0, url.length() - 1);
        }
        if (url.endsWith("/v1/messages")) {
            return url;
        }
        if (url.endsWith("/v1")) {
            return url + "/messages";
        }
        return url + "/v1/messages";
    }

    static String resolveGeminiStreamUrl(AiModelConfig config) {
        String url = hasText(config.getApiUrl()) ? config.getApiUrl().trim() : "";
        if (url.contains(":streamGenerateContent")) {
            return url;
        }
        if (url.endsWith("/")) {
            url = url.substring(0, url.length() - 1);
        }
        if (url.contains("generativelanguage.googleapis.com")) {
            return url + "/models/" + config.getModelName() + ":streamGenerateContent?alt=sse";
        }
        return "https://generativelanguage.googleapis.com/v1beta/models/" +
                config.getModelName() + ":streamGenerateContent?alt=sse";
    }

    static HttpHeaders jsonHeaders(String apiKey) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        if (hasText(apiKey)) {
            headers.setBearerAuth(apiKey);
        }
        return headers;
    }

    public static void applyOpenAiReasoningOptions(AiModelConfig config, Map<String, Object> body, String reasoningMode) {
        String name = config.getModelName() == null ? "" : config.getModelName().toLowerCase(Locale.ROOT);
        if (!isReasoningRequested(reasoningMode)) {
            if (name.contains("deepseek") && !name.contains("reasoner")) {
                body.put("thinking", Map.of("type", "disabled"));
            }
            return;
        }
        if (name.contains("deepseek") && !name.contains("reasoner")) {
            body.put("thinking", Map.of("type", "enabled"));
            return;
        }
        if (name.startsWith("o1") || name.startsWith("o3") || name.startsWith("o4") || name.startsWith("gpt-5")) {
            body.put("reasoning", Map.of("effort", "DEEP".equals(reasoningMode) ? "high" : "medium"));
        }
    }

    static String firstTextAt(JsonNode root, String... paths) {
        if (root == null || paths == null) {
            return "";
        }
        for (String path : paths) {
            JsonNode node = root.at(path);
            String text = firstText(node);
            if (hasContent(text)) {
                return text;
            }
        }
        return "";
    }

    static String firstText(JsonNode... nodes) {
        if (nodes == null) {
            return "";
        }
        for (JsonNode node : nodes) {
            if (node == null || node.isMissingNode() || node.isNull()) {
                continue;
            }
            String text = node.isTextual() ? node.asText("") : node.toString();
            if (hasContent(text)) {
                return text;
            }
        }
        return "";
    }

    static Map<String, Object> usageFromOpenAi(JsonNode root) {
        JsonNode usage = root == null ? null : root.path("usage");
        if (usage == null || usage.isMissingNode() || usage.isNull()) {
            return Map.of();
        }
        Map<String, Object> row = new LinkedHashMap<>();
        if (usage.has("prompt_tokens")) row.put("promptTokens", usage.path("prompt_tokens").asInt());
        if (usage.has("completion_tokens")) row.put("completionTokens", usage.path("completion_tokens").asInt());
        if (usage.has("total_tokens")) row.put("totalTokens", usage.path("total_tokens").asInt());
        return row;
    }

    static BusinessException httpError(RestClientResponseException e, String apiKey) {
        String retryAfter = e.getResponseHeaders() == null ? null : e.getResponseHeaders().getFirst("Retry-After");
        return new BusinessException(ProviderFailure.http(e.getStatusCode().value(), e.getResponseBodyAsString(), retryAfter, apiKey));
    }
}
