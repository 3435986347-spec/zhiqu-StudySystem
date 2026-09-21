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
import java.util.Map;
import java.util.Set;

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

    /**
     * 唯一的 BLOCKER 产生点 —— 在此之前，{@code shouldBlockFinalWrite} 要求的
     * {@code BLOCKER + BLOCK_FINAL_WRITE} 这对字面量<b>只出现在那个判断里，没有任何产生点</b>，
     * 于是那条阻断路径恒为假、调用方的 throw 不可达：一个看上去在防、实际什么都不防的守卫。
     *
     * <p>为什么只开这一个口子：用户显式勾了要读哪几份资料，一条都没读到时还照常回答，
     * 等于把通用知识冒充成「基于你的资料」。其余情形（抓取失败、结论缺证据）一律 WARNING ——
     * 它们会进回答提示词让模型收敛措辞，但不值得让用户拿不到回答。
     * 再开第二个口子之前先问这句：这件事值得让用户拿不到回答吗。
     */
    static final String SELECTED_SOURCES_UNUSABLE = "SELECTED_SOURCES_UNUSABLE";

    @Override
    @Transactional
    public List<AiVerifierFinding> verifyRun(Long runId, boolean selectedSourcesWithoutEvidence) {
        List<AiVerifierFinding> findings = new ArrayList<>();

        if (selectedSourcesWithoutEvidence) {
            findings.add(blackboardService.createFinding(
                    runId,
                    null,
                    "BLOCKER",
                    SELECTED_SOURCES_UNUSABLE,
                    "用户选定的资料本轮一条都没取到，不能在无证据的情况下按「基于你的资料」作答。",
                    "RUN",
                    runId,
                    "BLOCK_FINAL_WRITE"
            ));
        }

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

    /** 答案侧：模型带出来的引用必须出自本轮真实取到的证据。 */
    @Override
    @Transactional
    public List<AiVerifierFinding> verifyAnswerCitations(Long runId, List<Map<String, Object>> citationRows,
                                                         Set<String> trustedUrls) {
        List<AiVerifierFinding> findings = new ArrayList<>();
        if (citationRows == null || citationRows.isEmpty()) {
            return findings;
        }
        for (Map<String, Object> row : citationRows) {
            Object url = row == null ? null : row.get("url");
            String value = url == null ? "" : String.valueOf(url).trim();
            if (value.isEmpty() || trustedUrls.contains(value)) {
                continue;
            }
            findings.add(blackboardService.createFinding(
                    runId,
                    null,
                    "WARNING",
                    "CITATION_NOT_IN_EVIDENCE",
                    "回答里带出的来源不在本轮实际取到的证据里：" + value,
                    "RUN",
                    runId,
                    "WARN"
            ));
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
