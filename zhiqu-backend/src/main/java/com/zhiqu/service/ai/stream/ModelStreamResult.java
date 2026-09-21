package com.zhiqu.service.ai.stream;

import java.util.Map;

public record ModelStreamResult(String content, String reasoningSummary, Map<String, Object> usage) {
    public static ModelStreamResult empty() {
        return new ModelStreamResult("", "", Map.of());
    }
}
