package com.zhiqu.service.ai.stream;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.AiModelConfig;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.client.RestTemplate;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

final class AiStreamAdapterSupport {
    private AiStreamAdapterSupport() {
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
        factory.setReadTimeout(60_000);
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

    static void applyOpenAiReasoningOptions(AiModelConfig config, Map<String, Object> body, String reasoningMode) {
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

    static String extractAiErrorDetail(String body) {
        if (!hasText(body)) {
            return "AI 接口调用失败";
        }
        try {
            JsonNode root = new ObjectMapper().readTree(body);
            String message = firstTextAt(root, "/error/message", "/message", "/error");
            if (hasText(message)) {
                return message;
            }
        } catch (Exception ignored) {
            // fall through
        }
        return body.length() > 500 ? body.substring(0, 500) + "..." : body;
    }

    static BusinessException httpError(RestClientResponseException e) {
        return new BusinessException("AI 接口调用失败：" + extractAiErrorDetail(e.getResponseBodyAsString()));
    }
}
