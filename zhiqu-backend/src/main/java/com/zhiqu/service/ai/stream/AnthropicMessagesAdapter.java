package com.zhiqu.service.ai.stream;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.client.RestTemplate;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Consumer;

@Component
public class AnthropicMessagesAdapter implements ModelStreamAdapter {
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final RestTemplate restTemplate = AiStreamAdapterSupport.timeoutRestTemplate();

    @Value("${app.ai.temperature:}")
    private String temperature;

    @Override
    public boolean supports(String providerType) {
        return "ANTHROPIC".equals(providerType == null ? "" : providerType.toUpperCase(Locale.ROOT));
    }

    @Override
    public ModelStreamResult stream(ModelStreamRequest request, Consumer<NormalizedStreamEvent> sink) {
        StringBuilder content = new StringBuilder();
        StringBuilder reasoning = new StringBuilder();
        Map<String, Object> usage = new LinkedHashMap<>();
        try {
            Map<String, Object> body = anthropicBody(request);
            body.put("stream", true);
            AiStreamAdapterSupport.applyAnthropicThinking(body, request.reasoningMode(), request.config().getModelName());
            restTemplate.execute(
                    AiStreamAdapterSupport.resolveAnthropicMessagesUrl(request.config().getApiUrl()),
                    HttpMethod.POST,
                    httpRequest -> {
                        httpRequest.getHeaders().putAll(anthropicHeaders(request));
                        objectMapper.writeValue(httpRequest.getBody(), body);
                    },
                    response -> {
                        try (BufferedReader reader = new BufferedReader(new InputStreamReader(response.getBody(), StandardCharsets.UTF_8))) {
                            String line;
                            while ((line = reader.readLine()) != null) {
                                if (!line.startsWith("data:")) continue;
                                String data = line.substring(5).trim();
                                if (data.isBlank() || "[DONE]".equals(data)) continue;
                                JsonNode root = objectMapper.readTree(data);
                                handleEvent(root, request, sink, content, reasoning, usage);
                            }
                        }
                        return null;
                    });
            return new ModelStreamResult(content.toString(), reasoning.toString(), usage);
        } catch (BusinessException e) {
            throw e;
        } catch (RestClientResponseException e) {
            throw AiStreamAdapterSupport.httpError(e);
        } catch (Exception e) {
            throw new BusinessException("Anthropic 流式接口调用失败：" + e.getMessage());
        }
    }

    private void handleEvent(JsonNode root, ModelStreamRequest request, Consumer<NormalizedStreamEvent> sink,
                             StringBuilder content, StringBuilder reasoning, Map<String, Object> usage) {
        String type = root.path("type").asText("");
        if ("error".equals(type)) {
            throw new BusinessException(AiStreamAdapterSupport.extractAiErrorDetail(root.toString()));
        }
        JsonNode delta = root.path("delta");
        String deltaType = delta.path("type").asText("");
        if ("text_delta".equals(deltaType)) {
            String text = delta.path("text").asText("");
            if (AiStreamAdapterSupport.hasContent(text)) {
                content.append(text);
                sink.accept(NormalizedStreamEvent.message(text));
            }
        }
        if (AiStreamAdapterSupport.isReasoningRequested(request.reasoningMode()) &&
                ("thinking_delta".equals(deltaType) || deltaType.contains("thinking"))) {
            String thought = AiStreamAdapterSupport.firstText(delta.path("thinking"), delta.path("text"));
            if (AiStreamAdapterSupport.hasContent(thought)) {
                reasoning.append(thought);
                sink.accept(NormalizedStreamEvent.reasoning(thought));
            }
        }
        if ("citations_delta".equals(deltaType) && delta.has("citation")) {
            sink.accept(NormalizedStreamEvent.citation(citationFromNode(delta.path("citation"))));
        }
        if (root.has("usage")) {
            JsonNode node = root.path("usage");
            Map<String, Object> row = new LinkedHashMap<>();
            if (node.has("input_tokens")) row.put("promptTokens", node.path("input_tokens").asInt());
            if (node.has("output_tokens")) row.put("completionTokens", node.path("output_tokens").asInt());
            if (!row.isEmpty()) {
                int total = ((Number) row.getOrDefault("promptTokens", 0)).intValue()
                        + ((Number) row.getOrDefault("completionTokens", 0)).intValue();
                row.put("totalTokens", total);
                usage.clear();
                usage.putAll(row);
                sink.accept(NormalizedStreamEvent.usage(row));
            }
        }
    }

    private HttpHeaders anthropicHeaders(ModelStreamRequest request) {
        if (!AiStreamAdapterSupport.hasText(request.apiKey())) {
            throw new BusinessException("Anthropic 模型缺少 API Key");
        }
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(org.springframework.http.MediaType.APPLICATION_JSON);
        headers.set("x-api-key", request.apiKey());
        headers.set("anthropic-version", request.anthropicVersion());
        return headers;
    }

    private Map<String, Object> anthropicBody(ModelStreamRequest request) {
        StringBuilder system = new StringBuilder();
        List<Map<String, Object>> anthMessages = new ArrayList<>();
        for (Map<String, Object> message : request.messages()) {
            String role = String.valueOf(message.getOrDefault("role", ""));
            Object content = message.get("content");
            if ("system".equals(role)) {
                if (content != null) {
                    if (system.length() > 0) system.append("\n\n");
                    system.append(content);
                }
            } else if ("user".equals(role) || "assistant".equals(role)) {
                anthMessages.add(Map.of("role", role, "content", String.valueOf(content == null ? "" : content)));
            }
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", request.config().getModelName());
        body.put("max_tokens", 4096);
        AiStreamAdapterSupport.applyTemperature(body, temperature);
        if (system.length() > 0) body.put("system", system.toString());
        body.put("messages", anthMessages);
        return body;
    }

    private Map<String, Object> citationFromNode(JsonNode node) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("title", AiStreamAdapterSupport.firstText(node.path("title"), node.path("cited_text")));
        row.put("url", node.path("url").asText(""));
        row.put("snippet", AiStreamAdapterSupport.firstText(node.path("snippet"), node.path("cited_text")));
        row.put("sourceType", "MODEL_CITATION");
        row.put("status", "OK");
        return row;
    }
}
