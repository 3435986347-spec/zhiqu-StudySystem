package com.zhiqu.service.ai.stream;

import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.stereotype.Component;

import java.util.Locale;
import java.util.Map;
import java.util.function.Consumer;

@Component
public class SenseNovaAdapter extends OpenAiChatCompatibleAdapter {
    @Override
    public boolean supports(String providerType) {
        return "SENSENOVA".equals(providerType == null ? "" : providerType.toUpperCase(Locale.ROOT));
    }

    @Override
    protected void handleChunk(JsonNode root, ModelStreamRequest request, Consumer<NormalizedStreamEvent> sink,
                               StringBuilder content, StringBuilder reasoning, Map<String, Object> usage) {
        super.handleChunk(root, request, sink, content, reasoning, usage);
        String customText = AiStreamAdapterSupport.firstTextAt(root,
                "/delta/text",
                "/output/text",
                "/message/content",
                "/content",
                "/text");
        if (AiStreamAdapterSupport.hasText(customText) && content.indexOf(customText) < 0) {
            content.append(customText);
            sink.accept(NormalizedStreamEvent.message(customText));
        }
        if (AiStreamAdapterSupport.isReasoningRequested(request.reasoningMode())) {
            String thought = AiStreamAdapterSupport.firstTextAt(root,
                    "/delta/thinking",
                    "/delta/reasoning",
                    "/reasoning_content",
                    "/thinking");
            if (AiStreamAdapterSupport.hasText(thought) && reasoning.indexOf(thought) < 0) {
                reasoning.append(thought);
                sink.accept(NormalizedStreamEvent.reasoning(thought));
            }
        }
    }
}
