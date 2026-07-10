package com.zhiqu.service.ai.stream;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessException;
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
public class GeminiGenerateContentAdapter implements ModelStreamAdapter {
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final RestTemplate restTemplate = AiStreamAdapterSupport.timeoutRestTemplate();

    @Override
    public boolean supports(String providerType) {
        return "GEMINI".equals(providerType == null ? "" : providerType.toUpperCase(Locale.ROOT));
    }

    @Override
    public ModelStreamResult stream(ModelStreamRequest request, Consumer<NormalizedStreamEvent> sink) {
        StringBuilder content = new StringBuilder();
        Map<String, Object> usage = new LinkedHashMap<>();
        try {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("contents", toGeminiContents(request.messages()));
            body.put("generationConfig", Map.of("temperature", 0.3, "maxOutputTokens", 4096));

            restTemplate.execute(
                    AiStreamAdapterSupport.resolveGeminiStreamUrl(request.config()),
                    HttpMethod.POST,
                    httpRequest -> {
                        httpRequest.getHeaders().putAll(AiStreamAdapterSupport.jsonHeaders(""));
                        if (AiStreamAdapterSupport.hasText(request.apiKey())) {
                            httpRequest.getHeaders().set("x-goog-api-key", request.apiKey());
                        }
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
                                handleChunk(root, sink, content, usage);
                            }
                        }
                        return null;
                    });
            return new ModelStreamResult(content.toString(), "", usage);
        } catch (BusinessException e) {
            throw e;
        } catch (RestClientResponseException e) {
            throw AiStreamAdapterSupport.httpError(e);
        } catch (Exception e) {
            throw new BusinessException("Gemini 流式接口调用失败：" + e.getMessage());
        }
    }

    private List<Map<String, Object>> toGeminiContents(List<Map<String, Object>> messages) {
        List<Map<String, Object>> contents = new ArrayList<>();
        StringBuilder system = new StringBuilder();
        for (Map<String, Object> message : messages) {
            String role = String.valueOf(message.getOrDefault("role", ""));
            String content = String.valueOf(message.getOrDefault("content", ""));
            if ("system".equals(role)) {
                if (system.length() > 0) system.append("\n\n");
                system.append(content);
                continue;
            }
            String geminiRole = "assistant".equals(role) ? "model" : "user";
            if (system.length() > 0 && "user".equals(geminiRole)) {
                content = system + "\n\n" + content;
                system.setLength(0);
            }
            contents.add(Map.of("role", geminiRole, "parts", List.of(Map.of("text", content))));
        }
        if (contents.isEmpty() && system.length() > 0) {
            contents.add(Map.of("role", "user", "parts", List.of(Map.of("text", system.toString()))));
        }
        return contents;
    }

    private void handleChunk(JsonNode root, Consumer<NormalizedStreamEvent> sink,
                             StringBuilder content, Map<String, Object> usage) {
        JsonNode parts = root.at("/candidates/0/content/parts");
        if (parts.isArray()) {
            for (JsonNode part : parts) {
                String text = part.path("text").asText("");
                if (AiStreamAdapterSupport.hasContent(text)) {
                    content.append(text);
                    sink.accept(NormalizedStreamEvent.message(text));
                }
            }
        }
        JsonNode grounding = root.at("/candidates/0/groundingMetadata/groundingChunks");
        if (grounding.isArray()) {
            for (JsonNode chunk : grounding) {
                JsonNode web = chunk.path("web");
                if (web.isMissingNode() || web.isNull()) continue;
                Map<String, Object> citation = new LinkedHashMap<>();
                citation.put("title", web.path("title").asText(web.path("uri").asText("Gemini source")));
                citation.put("url", web.path("uri").asText(""));
                citation.put("snippet", "");
                citation.put("sourceType", "MODEL_CITATION");
                citation.put("status", "OK");
                sink.accept(NormalizedStreamEvent.citation(citation));
            }
        }
        JsonNode usageNode = root.path("usageMetadata");
        if (!usageNode.isMissingNode() && !usageNode.isNull()) {
            Map<String, Object> row = new LinkedHashMap<>();
            if (usageNode.has("promptTokenCount")) row.put("promptTokens", usageNode.path("promptTokenCount").asInt());
            if (usageNode.has("candidatesTokenCount")) row.put("completionTokens", usageNode.path("candidatesTokenCount").asInt());
            if (usageNode.has("totalTokenCount")) row.put("totalTokens", usageNode.path("totalTokenCount").asInt());
            if (!row.isEmpty()) {
                usage.clear();
                usage.putAll(row);
                sink.accept(NormalizedStreamEvent.usage(row));
            }
        }
    }
}
