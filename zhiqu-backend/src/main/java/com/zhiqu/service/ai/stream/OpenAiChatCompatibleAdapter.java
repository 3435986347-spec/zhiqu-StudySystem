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
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.function.Consumer;

@Component
public class OpenAiChatCompatibleAdapter implements ModelStreamAdapter {
    protected final ObjectMapper objectMapper;
    protected final RestTemplate restTemplate;

    public OpenAiChatCompatibleAdapter() {
        this.objectMapper = new ObjectMapper();
        this.restTemplate = AiStreamAdapterSupport.timeoutRestTemplate();
    }

    @Override
    public boolean supports(String providerType) {
        String type = providerType == null ? "" : providerType.toUpperCase(Locale.ROOT);
        return "OPENAI_COMPATIBLE".equals(type)
                || "VLLM_OPENAI_COMPATIBLE".equals(type)
                || "OLLAMA".equals(type);
    }

    @Override
    public ModelStreamResult stream(ModelStreamRequest request, Consumer<NormalizedStreamEvent> sink) {
        StringBuilder content = new StringBuilder();
        StringBuilder reasoning = new StringBuilder();
        Map<String, Object> usage = new HashMap<>();
        try {
            Map<String, Object> body = new HashMap<>();
            body.put("model", request.config().getModelName());
            body.put("messages", request.messages());
            body.put("temperature", 0.3);
            body.put("max_tokens", 4096);
            body.put("stream", true);
            AiStreamAdapterSupport.applyOpenAiReasoningOptions(request.config(), body, request.reasoningMode());

            restTemplate.execute(
                    AiStreamAdapterSupport.resolveChatCompletionsUrl(request.config().getApiUrl()),
                    HttpMethod.POST,
                    httpRequest -> {
                        httpRequest.getHeaders().putAll(AiStreamAdapterSupport.jsonHeaders(request.apiKey()));
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
                                if (root.has("error")) {
                                    throw new BusinessException(AiStreamAdapterSupport.extractAiErrorDetail(root.toString()));
                                }
                                handleChunk(root, request, sink, content, reasoning, usage);
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
            throw new BusinessException("AI 流式接口调用失败：" + e.getMessage());
        }
    }

    protected void handleChunk(JsonNode root, ModelStreamRequest request, Consumer<NormalizedStreamEvent> sink,
                               StringBuilder content, StringBuilder reasoning, Map<String, Object> usage) {
        String delta = AiStreamAdapterSupport.firstTextAt(root,
                "/choices/0/delta/content",
                "/choices/0/message/content");
        if (AiStreamAdapterSupport.hasText(delta)) {
            content.append(delta);
            sink.accept(NormalizedStreamEvent.message(delta));
        }
        if (AiStreamAdapterSupport.isReasoningRequested(request.reasoningMode())) {
            String thought = AiStreamAdapterSupport.firstTextAt(root,
                    "/choices/0/delta/reasoning_content",
                    "/choices/0/delta/reasoning",
                    "/choices/0/message/reasoning_content");
            if (AiStreamAdapterSupport.hasText(thought)) {
                reasoning.append(thought);
                sink.accept(NormalizedStreamEvent.reasoning(thought));
            }
        }
        Map<String, Object> chunkUsage = AiStreamAdapterSupport.usageFromOpenAi(root);
        if (!chunkUsage.isEmpty()) {
            usage.clear();
            usage.putAll(chunkUsage);
            sink.accept(NormalizedStreamEvent.usage(chunkUsage));
        }
    }
}
