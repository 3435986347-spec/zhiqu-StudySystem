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

    static boolean isReasoningRequested(String mode) {
        String normalized = mode == null ? "OFF" : mode.trim().toUpperCase(Locale.ROOT);
        return "AUTO".equals(normalized) || "DEEP".equals(normalized);
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
            if (hasText(text)) {
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
            if (hasText(text)) {
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
