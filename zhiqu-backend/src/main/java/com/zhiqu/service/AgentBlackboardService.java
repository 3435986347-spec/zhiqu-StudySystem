package com.zhiqu.service;

import com.zhiqu.entity.AiAgentClaim;
import com.zhiqu.entity.AiAgentEvidence;
import com.zhiqu.entity.AiVerifierFinding;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

public interface AgentBlackboardService {
    AiAgentEvidence createEvidence(Long runId, Long taskId, Long stepId, String sourceType,
                                   String sourceId, Long artifactId, String snippet,
                                   Map<String, Object> metadata);

    AiAgentClaim createClaim(Long runId, Long stepId, Long taskId, String claimType, String content,
                             BigDecimal confidence, List<Long> evidenceIds, Map<String, Object> metadata);

    AiVerifierFinding createFinding(Long runId, Long taskId, String severity, String code,
                                    String message, String targetType, Long targetId, String action);

    List<Map<String, Object>> listEvidenceRows(Long runId);

    List<Map<String, Object>> listClaimRows(Long runId);

    List<Map<String, Object>> listFindingRows(Long runId);
}
