package com.zhiqu.service.ai.stream;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.service.ai.OutputLimits;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpMethod;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.client.RestTemplate;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.function.Consumer;

@Component
public class OpenAiChatCompatibleAdapter implements ModelStreamAdapter {
    protected final ObjectMapper objectMapper;
    protected final RestTemplate restTemplate;

    @Value("${app.ai.temperature:}")
    protected String temperature;

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
            AiStreamAdapterSupport.applyTemperature(body, temperature);
            body.put("stream", true);
            AiStreamAdapterSupport.applyOpenAiReasoningOptions(request.config(), body, request.reasoningMode());

            // 输出上限和命令行同一档（OutputLimits，第五十四轮：原来写死 4096，深度思考时想完就没地方写回答）；供应商不收就降一档再来
            AiStreamAdapterSupport.StreamEnd end = null;
            RestClientResponseException rejected = null;
            for (int limit : OutputLimits.fallbackLimits(OutputLimits.ANSWER_MAX_TOKENS)) {
                body.put("max_tokens", limit);
                try {
                    end = restTemplate.execute(
                            AiStreamAdapterSupport.resolveChatCompletionsUrl(request.config().getApiUrl()),
                            HttpMethod.POST,
                            httpRequest -> {
                                httpRequest.getHeaders().putAll(AiStreamAdapterSupport.jsonHeaders(request.apiKey()));
                                objectMapper.writeValue(httpRequest.getBody(), body);
                            },
                            response -> AiStreamAdapterSupport.readSse(response, objectMapper, (event, root, streamEnd) -> {
                                if (root.has("error")) {
                                    throw AiStreamAdapterSupport.inStreamError(root, request.apiKey());
                                }
                                handleChunk(root, request, sink, content, reasoning, usage);
                                JsonNode finish = root.at("/choices/0/finish_reason");
                                if (finish.isTextual()) {
                                    streamEnd.finish(finish.asText());
                                }
                            }));
                    rejected = null;
                    break;
                } catch (RestClientResponseException e) {
                    if (OutputLimits.rejectsMaxTokens(e.getStatusCode().value(), e.getResponseBodyAsString())
                            && content.length() == 0 && reasoning.length() == 0) {
                        rejected = e;
                        continue;
                    }
                    throw e;
                }
            }
            if (rejected != null) {
                throw rejected;
            }
            if (end != null && end.dataLines == 0 && end.contentType.toLowerCase(Locale.ROOT).contains("json")) {
                // 有的代理不支持流式，stream:true 也回一整段 JSON：照非流式的格式认出来，而不是当成空回答
                wholeBody(end, request, sink, content, reasoning, usage);
            }
            AiStreamAdapterSupport.requireComplete(end, expectsEndSignal());
            return new ModelStreamResult(content.toString(), reasoning.toString(), usage, end.finishReason);
        } catch (BusinessException e) {
            throw e;
        } catch (RestClientResponseException e) {
            throw AiStreamAdapterSupport.httpError(e, request.apiKey());
        } catch (Exception e) {
            throw AiStreamAdapterSupport.ioError(e);
        }
    }

    /** 这家协议有没有「说完了」的信号（[DONE] 或 finish_reason）。没有的话，流断在半路和正常结束分不出来。 */
    protected boolean expectsEndSignal() {
        return true;
    }

    private void wholeBody(AiStreamAdapterSupport.StreamEnd end, ModelStreamRequest request, Consumer<NormalizedStreamEvent> sink,
                           StringBuilder content, StringBuilder reasoning, Map<String, Object> usage) {
        JsonNode root;
        try {
            root = objectMapper.readTree(end.rawBody);
        } catch (Exception e) {
            return;
        }
        if (root == null || !root.isObject()) {
            return;
        }
        if (root.has("error")) {
            throw AiStreamAdapterSupport.inStreamError(root, request.apiKey());
        }
        handleChunk(root, request, sink, content, reasoning, usage);
        end.dataLines++;
        JsonNode finish = root.at("/choices/0/finish_reason");
        end.finish(finish.isTextual() ? finish.asText() : "stop");
    }

    protected void handleChunk(JsonNode root, ModelStreamRequest request, Consumer<NormalizedStreamEvent> sink,
                               StringBuilder content, StringBuilder reasoning, Map<String, Object> usage) {
        String delta = AiStreamAdapterSupport.firstTextAt(root,
                "/choices/0/delta/content",
                "/choices/0/message/content");
        if (AiStreamAdapterSupport.hasContent(delta)) {
            content.append(delta);
            sink.accept(NormalizedStreamEvent.message(delta));
        }
        if (AiStreamAdapterSupport.isReasoningRequested(request.reasoningMode())) {
            String thought = AiStreamAdapterSupport.firstTextAt(root,
                    "/choices/0/delta/reasoning_content",
                    "/choices/0/delta/reasoning",
                    "/choices/0/message/reasoning_content");
            if (AiStreamAdapterSupport.hasContent(thought)) {
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
