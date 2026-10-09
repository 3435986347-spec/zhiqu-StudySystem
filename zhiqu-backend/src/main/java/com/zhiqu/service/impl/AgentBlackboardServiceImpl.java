package com.zhiqu.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.entity.AiAgentClaim;
import com.zhiqu.entity.AiAgentEvidence;
import com.zhiqu.entity.AiVerifierFinding;
import com.zhiqu.mapper.AiAgentClaimMapper;
import com.zhiqu.mapper.AiAgentEvidenceMapper;
import com.zhiqu.mapper.AiVerifierFindingMapper;
import com.zhiqu.service.AgentBlackboardService;
import com.zhiqu.service.ClaimService;
import com.zhiqu.service.EvidenceService;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.util.*;

@Service
public class AgentBlackboardServiceImpl implements AgentBlackboardService, ClaimService, EvidenceService {
    private final AiAgentEvidenceMapper evidenceMapper;
    private final AiAgentClaimMapper claimMapper;
    private final AiVerifierFindingMapper findingMapper;
    private final ObjectMapper objectMapper;

    public AgentBlackboardServiceImpl(AiAgentEvidenceMapper evidenceMapper,
                                      AiAgentClaimMapper claimMapper,
                                      AiVerifierFindingMapper findingMapper,
                                      ObjectMapper objectMapper) {
        this.evidenceMapper = evidenceMapper;
        this.claimMapper = claimMapper;
        this.findingMapper = findingMapper;
        this.objectMapper = objectMapper;
    }

    @Override
    @Transactional
    public AiAgentEvidence createEvidence(Long runId, Long taskId, Long stepId, String sourceType,
                                          String sourceId, Long artifactId, String snippet,
                                          Map<String, Object> metadata) {
        AiAgentEvidence evidence = new AiAgentEvidence();
        evidence.setRunId(runId);
        evidence.setTaskId(taskId);
        evidence.setStepId(stepId);
        evidence.setSourceType(sourceType);
        evidence.setSourceId(sourceId);
        evidence.setArtifactId(artifactId);
        evidence.setSnippet(limit(snippet, 1200));
        evidence.setMetadataJson(toJson(metadata == null ? Map.of() : metadata));
        evidenceMapper.insert(evidence);
        return evidence;
    }

    @Override
    @Transactional
    public AiAgentClaim createClaim(Long runId, Long stepId, Long taskId, String claimType, String content,
                                    BigDecimal confidence, List<Long> evidenceIds, Map<String, Object> metadata) {
        AiAgentClaim claim = new AiAgentClaim();
        claim.setRunId(runId);
        claim.setStepId(stepId);
        claim.setTaskId(taskId);
        claim.setClaimType(claimType);
        claim.setContent(limit(content, 3000));
        claim.setConfidence(confidence);
        claim.setEvidenceIdsJson(toJson(evidenceIds == null ? List.of() : evidenceIds));
        claim.setMetadataJson(toJson(metadata == null ? Map.of() : metadata));
        claimMapper.insert(claim);
        return claim;
    }

    @Override
    @Transactional
    public AiVerifierFinding createFinding(Long runId, Long taskId, String severity, String code,
                                           String message, String targetType, Long targetId, String action) {
        AiVerifierFinding finding = new AiVerifierFinding();
        finding.setRunId(runId);
        finding.setTaskId(taskId);
        finding.setSeverity(severity == null ? "INFO" : severity);
        finding.setCode(code == null ? "INFO" : code);
        finding.setMessage(limit(message, 1000));
        finding.setTargetType(targetType);
        finding.setTargetId(targetId);
        finding.setAction(action == null ? "ALLOW" : action);
        findingMapper.insert(finding);
        return finding;
    }

    @Override
    public List<Map<String, Object>> listEvidenceRows(Long runId) {
        return evidenceMapper.selectList(new LambdaQueryWrapper<AiAgentEvidence>()
                        .eq(AiAgentEvidence::getRunId, runId)
                        .orderByAsc(AiAgentEvidence::getId))
                .stream().map(this::evidenceRow).toList();
    }

    @Override
    public List<Map<String, Object>> listClaimRows(Long runId) {
        return claimMapper.selectList(new LambdaQueryWrapper<AiAgentClaim>()
                        .eq(AiAgentClaim::getRunId, runId)
                        .orderByAsc(AiAgentClaim::getId))
                .stream().map(this::claimRow).toList();
    }

    @Override
    public List<Map<String, Object>> listFindingRows(Long runId) {
        return findingMapper.selectList(new LambdaQueryWrapper<AiVerifierFinding>()
                        .eq(AiVerifierFinding::getRunId, runId)
                        .orderByAsc(AiVerifierFinding::getId))
                .stream().map(this::findingRow).toList();
    }

    private Map<String, Object> evidenceRow(AiAgentEvidence evidence) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", evidence.getId());
        row.put("runId", evidence.getRunId());
        row.put("taskId", evidence.getTaskId());
        row.put("stepId", evidence.getStepId());
        row.put("sourceType", evidence.getSourceType());
        row.put("sourceId", evidence.getSourceId());
        row.put("artifactId", evidence.getArtifactId());
        row.put("snippet", evidence.getSnippet());
        row.put("metadata", parseMap(evidence.getMetadataJson()));
        row.put("createdAt", evidence.getCreatedAt());
        return row;
    }

    private Map<String, Object> claimRow(AiAgentClaim claim) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", claim.getId());
        row.put("runId", claim.getRunId());
        row.put("stepId", claim.getStepId());
        row.put("taskId", claim.getTaskId());
        row.put("claimType", claim.getClaimType());
        row.put("content", claim.getContent());
        row.put("confidence", claim.getConfidence());
        row.put("evidenceIds", parseList(claim.getEvidenceIdsJson()));
        row.put("metadata", parseMap(claim.getMetadataJson()));
        row.put("createdAt", claim.getCreatedAt());
        return row;
    }

    private Map<String, Object> findingRow(AiVerifierFinding finding) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", finding.getId());
        row.put("runId", finding.getRunId());
        row.put("taskId", finding.getTaskId());
        row.put("severity", finding.getSeverity());
        row.put("code", finding.getCode());
        row.put("message", finding.getMessage());
        row.put("targetType", finding.getTargetType());
        row.put("targetId", finding.getTargetId());
        row.put("action", finding.getAction());
        row.put("createdAt", finding.getCreatedAt());
        return row;
    }

    private Map<String, Object> parseMap(String json) {
        if (json == null || json.isBlank()) {
            return new LinkedHashMap<>();
        }
        try {
            return objectMapper.readValue(json, LinkedHashMap.class);
        } catch (Exception e) {
            return new LinkedHashMap<>();
        }
    }

    private List<Object> parseList(String json) {
        if (json == null || json.isBlank()) {
            return List.of();
        }
        try {
            return objectMapper.readValue(json, List.class);
        } catch (Exception e) {
            return List.of();
        }
    }

    private String toJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (Exception e) {
            return "{}";
        }
    }

    private String limit(String value, int max) {
        String text = value == null ? "" : value;
        return text.length() <= max ? text : text.substring(0, max);
    }
}
