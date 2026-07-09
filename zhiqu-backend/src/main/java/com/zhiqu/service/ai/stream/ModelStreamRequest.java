package com.zhiqu.service.ai.stream;

import com.zhiqu.entity.AiModelConfig;

import java.util.List;
import java.util.Map;

public record ModelStreamRequest(
        AiModelConfig config,
        String apiKey,
        List<Map<String, Object>> messages,
        String reasoningMode,
        String anthropicVersion
) {
}
