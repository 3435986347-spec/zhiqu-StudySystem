package com.zhiqu.service.ai.stream;

import java.util.Map;

/**
 * @param finishReason 模型为什么停：{@code stop} / {@code length}（输出上限）/ {@code filtered}（内容审核）/ 其它原文；
 *                     供应商没说时是 null
 */
public record ModelStreamResult(String content, String reasoningSummary, Map<String, Object> usage, String finishReason) {
    public ModelStreamResult(String content, String reasoningSummary, Map<String, Object> usage) {
        this(content, reasoningSummary, usage, null);
    }

    public static ModelStreamResult empty() {
        return new ModelStreamResult("", "", Map.of());
    }
}
