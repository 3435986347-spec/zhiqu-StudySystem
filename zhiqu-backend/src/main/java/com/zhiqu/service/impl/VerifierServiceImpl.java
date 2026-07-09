package com.zhiqu.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.entity.AiAgentArtifact;
import com.zhiqu.entity.AiAgentClaim;
import com.zhiqu.entity.AiVerifierFinding;
import com.zhiqu.mapper.AiAgentArtifactMapper;
import com.zhiqu.mapper.AiAgentClaimMapper;
import com.zhiqu.service.AgentBlackboardService;
import com.zhiqu.service.VerifierService;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;

@Service
public class VerifierServiceImpl implements VerifierService {
    private final AiAgentArtifactMapper artifactMapper;
    private final AiAgentClaimMapper claimMapper;
    private final AgentBlackboardService blackboardService;

    public VerifierServiceImpl(AiAgentArtifactMapper artifactMapper,
                               AiAgentClaimMapper claimMapper,
                               AgentBlackboardService blackboardService) {
        this.artifactMapper = artifactMapper;
        this.claimMapper = claimMapper;
        this.blackboardService = blackboardService;
    }

    @Override
    @Transactional
    public List<AiVerifierFinding> verifyRun(Long runId) {
        List<AiVerifierFinding> findings = new ArrayList<>();

        List<AiAgentArtifact> failedSources = artifactMapper.selectList(new LambdaQueryWrapper<AiAgentArtifact>()
                .eq(AiAgentArtifact::getRunId, runId)
                .eq(AiAgentArtifact::getArtifactType, "FAILED_SOURCE"));
        for (AiAgentArtifact artifact : failedSources) {
            findings.add(blackboardService.createFinding(
                    runId,
                    null,
                    "WARNING",
                    "FAILED_SOURCE",
                    "Some web/source retrieval failed and was excluded from final evidence.",
                    "ARTIFACT",
                    artifact.getId(),
                    "WARN"
            ));
        }

        List<AiAgentClaim> claims = claimMapper.selectList(new LambdaQueryWrapper<AiAgentClaim>()
                .eq(AiAgentClaim::getRunId, runId));
        for (AiAgentClaim claim : claims) {
            if (claim.getEvidenceIdsJson() == null
                    || claim.getEvidenceIdsJson().isBlank()
                    || "[]".equals(claim.getEvidenceIdsJson().trim())) {
                findings.add(blackboardService.createFinding(
                        runId,
                        claim.getTaskId(),
                        "WARNING",
                        "MISSING_EVIDENCE",
                        "A generated claim has no linked evidence. Final answer should avoid unsupported certainty.",
                        "CLAIM",
                        claim.getId(),
                        "WARN"
                ));
            }
        }
        return findings;
    }

    @Override
    public boolean shouldBlockFinalWrite(List<AiVerifierFinding> findings) {
        if (findings == null || findings.isEmpty()) {
            return false;
        }
        return findings.stream().anyMatch(item ->
                "BLOCKER".equalsIgnoreCase(item.getSeverity())
                        && "BLOCK_FINAL_WRITE".equalsIgnoreCase(item.getAction()));
    }
}
