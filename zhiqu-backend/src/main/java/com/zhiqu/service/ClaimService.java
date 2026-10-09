package com.zhiqu.service;

import com.zhiqu.entity.AiAgentClaim;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

public interface ClaimService {
    AiAgentClaim createClaim(Long runId, Long stepId, Long taskId, String claimType, String content,
                             BigDecimal confidence, List<Long> evidenceIds, Map<String, Object> metadata);
}
