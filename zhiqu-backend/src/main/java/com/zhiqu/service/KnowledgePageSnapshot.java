package com.zhiqu.service;

/**
 * A single-query, normalized knowledge-page snapshot used as a trusted draft baseline.
 */
public record KnowledgePageSnapshot(
        Long pageId,
        String title,
        String pageType,
        String content,
        Integer version,
        String stateHash
) {
}
