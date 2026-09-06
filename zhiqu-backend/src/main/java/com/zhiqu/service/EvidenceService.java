package com.zhiqu.service;

import com.zhiqu.entity.AiAgentEvidence;

import java.util.Map;

public interface EvidenceService {
    AiAgentEvidence createEvidence(Long runId, Long taskId, Long stepId, String sourceType,
                                   String sourceId, Long artifactId, String snippet,
                                   Map<String, Object> metadata);
}
