package com.zhiqu.service.ai.stream;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessException;
import org.springframework.http.HttpMethod;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.client.RestTemplate;

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
            AiStreamAdapterSupport.StreamEnd end = restTemplate.execute(
                    AiStreamAdapterSupport.resolveResponsesUrl(request.config().getApiUrl()),
                    HttpMethod.POST,
                    httpRequest -> {
                        httpRequest.getHeaders().putAll(AiStreamAdapterSupport.jsonHeaders(request.apiKey()));
                        objectMapper.writeValue(httpRequest.getBody(), body);
                    },
                    response -> AiStreamAdapterSupport.readSse(response, objectMapper, (eventName, root, streamEnd) -> {
                        handleEvent(eventName, root, request.apiKey(), sink, content, reasoning, usage);
                        String type = root.path("type").asText(eventName == null ? "" : eventName);
                        if ("response.completed".equals(type)) {
                            streamEnd.finish("stop");
                        } else if ("response.incomplete".equals(type)) {
                            String reason = root.at("/response/incomplete_details/reason").asText("");
                            streamEnd.finish(reason.isBlank() ? "length" : reason);
                        }
                    }));
            AiStreamAdapterSupport.requireComplete(end, true);
            return new ModelStreamResult(content.toString(), reasoning.toString(), usage, end.finishReason);
        } catch (BusinessException e) {
            throw e;
        } catch (RestClientResponseException e) {
            throw AiStreamAdapterSupport.httpError(e, request.apiKey());
        } catch (Exception e) {
            throw AiStreamAdapterSupport.ioError(e);
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

    private void handleEvent(String eventName, JsonNode root, String apiKey, Consumer<NormalizedStreamEvent> sink,
                             StringBuilder content, StringBuilder reasoning, Map<String, Object> usage) {
        String type = root.path("type").asText(eventName == null ? "" : eventName);
        if (type.contains("error")) {
            throw AiStreamAdapterSupport.inStreamError(root, apiKey);
        }
        if ("response.failed".equals(type)) {
            throw AiStreamAdapterSupport.inStreamError(root.path("response"), apiKey);
        }
        if (type.contains("output_text.delta")) {
            String text = root.path("delta").asText("");
            if (AiStreamAdapterSupport.hasContent(text)) {
                content.append(text);
                sink.accept(NormalizedStreamEvent.message(text));
            }
        }
        if (type.contains("reasoning") && type.contains("delta")) {
            String text = root.path("delta").asText("");
            if (AiStreamAdapterSupport.hasContent(text)) {
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
