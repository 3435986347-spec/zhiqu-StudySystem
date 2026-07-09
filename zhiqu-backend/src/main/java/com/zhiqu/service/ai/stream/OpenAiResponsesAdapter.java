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
public class OpenAiResponsesAdapter implements ModelStreamAdapter {
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final RestTemplate restTemplate = AiStreamAdapterSupport.timeoutRestTemplate();

    @Override
    public boolean supports(String providerType) {
        return "OPENAI_RESPONSES".equals(providerType == null ? "" : providerType.toUpperCase(Locale.ROOT));
    }

    @Override
    public ModelStreamResult stream(ModelStreamRequest request, Consumer<NormalizedStreamEvent> sink) {
        StringBuilder content = new StringBuilder();
        StringBuilder reasoning = new StringBuilder();
        Map<String, Object> usage = new LinkedHashMap<>();
        try {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("model", request.config().getModelName());
            body.put("input", toResponsesInput(request.messages()));
            body.put("stream", true);
            if (AiStreamAdapterSupport.isReasoningRequested(request.reasoningMode())) {
                body.put("reasoning", Map.of("effort", "DEEP".equals(request.reasoningMode()) ? "high" : "medium"));
            }
            restTemplate.execute(
                    AiStreamAdapterSupport.resolveResponsesUrl(request.config().getApiUrl()),
                    HttpMethod.POST,
                    httpRequest -> {
                        httpRequest.getHeaders().putAll(AiStreamAdapterSupport.jsonHeaders(request.apiKey()));
                        objectMapper.writeValue(httpRequest.getBody(), body);
                    },
                    response -> {
                        try (BufferedReader reader = new BufferedReader(new InputStreamReader(response.getBody(), StandardCharsets.UTF_8))) {
                            String eventName = "";
                            String line;
                            while ((line = reader.readLine()) != null) {
                                if (line.startsWith("event:")) {
                                    eventName = line.substring(6).trim();
                                    continue;
                                }
                                if (!line.startsWith("data:")) continue;
                                String data = line.substring(5).trim();
                                if (data.isBlank() || "[DONE]".equals(data)) continue;
                                JsonNode root = objectMapper.readTree(data);
                                handleEvent(eventName, root, sink, content, reasoning, usage);
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
            throw new BusinessException("OpenAI Responses 流式接口调用失败：" + e.getMessage());
        }
    }

    private List<Map<String, Object>> toResponsesInput(List<Map<String, Object>> messages) {
        List<Map<String, Object>> rows = new ArrayList<>();
        for (Map<String, Object> message : messages) {
            rows.add(Map.of(
                    "role", String.valueOf(message.getOrDefault("role", "user")),
                    "content", String.valueOf(message.getOrDefault("content", ""))
            ));
        }
        return rows;
    }

    private void handleEvent(String eventName, JsonNode root, Consumer<NormalizedStreamEvent> sink,
                             StringBuilder content, StringBuilder reasoning, Map<String, Object> usage) {
        String type = root.path("type").asText(eventName == null ? "" : eventName);
        if (type.contains("error")) {
            throw new BusinessException(AiStreamAdapterSupport.extractAiErrorDetail(root.toString()));
        }
        if (type.contains("output_text.delta")) {
            String text = root.path("delta").asText("");
            if (AiStreamAdapterSupport.hasText(text)) {
                content.append(text);
                sink.accept(NormalizedStreamEvent.message(text));
            }
        }
        if (type.contains("reasoning") && type.contains("delta")) {
            String text = root.path("delta").asText("");
            if (AiStreamAdapterSupport.hasText(text)) {
                reasoning.append(text);
                sink.accept(NormalizedStreamEvent.reasoning(text));
            }
        }
        JsonNode usageNode = root.path("usage");
        if (!usageNode.isMissingNode() && !usageNode.isNull()) {
            Map<String, Object> row = new LinkedHashMap<>();
            if (usageNode.has("input_tokens")) row.put("promptTokens", usageNode.path("input_tokens").asInt());
            if (usageNode.has("output_tokens")) row.put("completionTokens", usageNode.path("output_tokens").asInt());
            if (usageNode.has("total_tokens")) row.put("totalTokens", usageNode.path("total_tokens").asInt());
            if (!row.isEmpty()) {
                usage.clear();
                usage.putAll(row);
                sink.accept(NormalizedStreamEvent.usage(row));
            }
        }
    }
}
