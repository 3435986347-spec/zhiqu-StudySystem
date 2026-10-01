package com.zhiqu.service.ai.stream;

import java.util.Map;

public record NormalizedStreamEvent(String type, String text, Map<String, Object> data) {
    public static NormalizedStreamEvent message(String text) {
        return new NormalizedStreamEvent("message.delta", text, Map.of("text", text));
    }

    public static NormalizedStreamEvent reasoning(String text) {
        return new NormalizedStreamEvent("reasoning.delta", text, Map.of("text", text));
    }

    public static NormalizedStreamEvent citation(Map<String, Object> citation) {
        return new NormalizedStreamEvent("citation", "", citation);
    }

    public static NormalizedStreamEvent usage(Map<String, Object> usage) {
        return new NormalizedStreamEvent("usage", "", usage);
    }

    public static NormalizedStreamEvent error(String message) {
        return new NormalizedStreamEvent("error", "", Map.of("message", message));
    }
}
