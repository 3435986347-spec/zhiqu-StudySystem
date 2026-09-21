package com.zhiqu.service.impl;

import com.zhiqu.entity.AiVerifierFinding;
import com.zhiqu.service.AgentBlackboardService;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 校验器的两侧：证据校验能不能真的阻断，答案引用核对能不能真的发现编造。
 *
 * <h2>阻断路径此前不可达</h2>
 *
 * <p>{@code shouldBlockFinalWrite} 要求 {@code severity=BLOCKER && action=BLOCK_FINAL_WRITE}，
 * 而在这一轮之前，<b>这两个字面量在全仓库只出现在那个判断里，没有任何产生点</b> ——
 * 恒为假，调用方的 {@code throw} 不可达。一个看上去在防、实际什么都不防的守卫，
 * 与 V27 那四列是同一个物种。
 *
 * <h2>四条判据两两互为反例</h2>
 *
 * <table border="1">
 *   <caption>各自买到什么</caption>
 *   <tr><th>判据</th><th>买到什么</th><th>扰动</th></tr>
 *   <tr><td>{@link #勾了资料源却零证据必须阻断()}</td>
 *       <td>这条路径<b>第一次可达</b>；也是唯一的 BLOCKER 产生点</td>
 *       <td>把 severity 改回 WARNING</td></tr>
 *   <tr><td>{@link #其余情形一律不得阻断()}</td>
 *       <td>防阻断口子扩大成「动不动就报错」</td>
 *       <td>把抓取失败那类也标成 BLOCKER</td></tr>
 *   <tr><td>{@link #编造的引用必须被标出()}</td>
 *       <td>防提供方回的 URL 直接冒充来源</td>
 *       <td>取消集合比对</td></tr>
 *   <tr><td>{@link #真实引用不得被误标()}</td>
 *       <td>上一条的反例</td>
 *       <td>让比对恒为不匹配</td></tr>
 * </table>
 *
 * <p>第 1、2 条互为反例（「一律阻断」满足 1、「从不阻断」满足 2），
 * 第 3、4 条互为反例（「一律标记」满足 3、「从不标记」满足 4）。
 * <b>单独任何一条都挡不住另一头</b> —— 这个性质比「各自见红」更强。
 */
class VerifierClosedLoopTest {

    /** 只记录被创建的 finding 的桩：校验逻辑不需要落库，也就不需要 Spring 上下文。 */
    private static final class RecordingBlackboard implements AgentBlackboardService {
        private final List<AiVerifierFinding> created = new ArrayList<>();

        @Override
        public AiVerifierFinding createFinding(Long runId, Long taskId, String severity, String code,
                                               String message, String targetType, Long targetId, String action) {
            AiVerifierFinding finding = new AiVerifierFinding();
            finding.setRunId(runId);
            finding.setTaskId(taskId);
            finding.setSeverity(severity);
            finding.setCode(code);
            finding.setMessage(message);
            finding.setTargetType(targetType);
            finding.setTargetId(targetId);
            finding.setAction(action);
            created.add(finding);
            return finding;
        }

        @Override public com.zhiqu.entity.AiAgentEvidence createEvidence(
                Long runId, Long taskId, Long stepId, String sourceType, String sourceId,
                Long artifactId, String content, Map<String, Object> metadata) { return null; }
        @Override public com.zhiqu.entity.AiAgentClaim createClaim(
                Long runId, Long stepId, Long taskId, String claimType, String statement,
                java.math.BigDecimal confidence, List<Long> evidenceIds, Map<String, Object> metadata) { return null; }
        @Override public List<Map<String, Object>> listEvidenceRows(Long runId) { return List.of(); }
        @Override public List<Map<String, Object>> listClaimRows(Long runId) { return List.of(); }
        @Override public List<Map<String, Object>> listFindingRows(Long runId) { return List.of(); }
    }

    @SuppressWarnings("unchecked")
    private static com.zhiqu.mapper.AiAgentArtifactMapper emptyArtifacts() {
        com.zhiqu.mapper.AiAgentArtifactMapper mapper = org.mockito.Mockito.mock(com.zhiqu.mapper.AiAgentArtifactMapper.class);
        org.mockito.Mockito.when(mapper.selectList(org.mockito.ArgumentMatchers.any())).thenReturn(List.of());
        return mapper;
    }

    @SuppressWarnings("unchecked")
    private static com.zhiqu.mapper.AiAgentClaimMapper emptyClaims() {
        com.zhiqu.mapper.AiAgentClaimMapper mapper = org.mockito.Mockito.mock(com.zhiqu.mapper.AiAgentClaimMapper.class);
        org.mockito.Mockito.when(mapper.selectList(org.mockito.ArgumentMatchers.any())).thenReturn(List.of());
        return mapper;
    }

    private VerifierServiceImpl serviceWithNoArtifacts(RecordingBlackboard blackboard) {
        // artifactMapper / claimMapper 传 null：本类只测不碰它们的两条路径 ——
        // 「勾了源却零证据」在查询之前就成立，引用核对根本不查库。
        // 真要走到查询就会 NPE 而不是静默通过，这比给一个空桩更诚实。
        return new VerifierServiceImpl(null, null, blackboard);
    }

    /**
     * <b>必须真的调 verifyRun</b>，不能自己手造那条 finding。
     *
     * <p>本判据第一版就是手造的：它只测到 {@code shouldBlockFinalWrite} 会不会认 BLOCKER，
     * 而把产生点改回 WARNING 之后它照样绿 —— 也就是说，即使回到「没有任何产生点」的原状，
     * 这条判据也发现不了。扰动逮到的，不是复核逮到的。
     */
    @Test
    void 勾了资料源却零证据必须阻断() {
        RecordingBlackboard blackboard = new RecordingBlackboard();
        VerifierServiceImpl service = new VerifierServiceImpl(emptyArtifacts(), emptyClaims(), blackboard);

        List<AiVerifierFinding> findings = service.verifyRun(1L, true);

        assertTrue(service.shouldBlockFinalWrite(findings),
                "用户指定了读哪几份资料、一条都没读到时必须阻断 —— 照常回答等于把通用知识"
                        + "冒充成「基于你的资料」。这是 BLOCKER 路径第一次可达。实际：" + findings);
        assertEquals(1, findings.size(), "该情形只该产出这一条");
        assertEquals(VerifierServiceImpl.SELECTED_SOURCES_UNUSABLE, findings.get(0).getCode());
    }

    @Test
    void 没有勾资料源时不得产出阻断() {
        RecordingBlackboard blackboard = new RecordingBlackboard();
        VerifierServiceImpl service = new VerifierServiceImpl(emptyArtifacts(), emptyClaims(), blackboard);

        List<AiVerifierFinding> findings = service.verifyRun(1L, false);

        assertTrue(findings.isEmpty(), "没东西可报告时不该凭空造 finding，实际：" + findings);
        assertFalse(service.shouldBlockFinalWrite(findings),
                "上一条的反例：没有它，「一律阻断」也能让上一条绿");
    }

    @Test
    void 其余情形一律不得阻断() {
        RecordingBlackboard blackboard = new RecordingBlackboard();
        List<AiVerifierFinding> warnings = new ArrayList<>();
        warnings.add(blackboard.createFinding(1L, null, "WARNING", "FAILED_SOURCE",
                "有来源抓取失败。", "ARTIFACT", 9L, "WARN"));
        warnings.add(blackboard.createFinding(1L, null, "WARNING", "MISSING_EVIDENCE",
                "有结论没有证据。", "CLAIM", 8L, "WARN"));

        assertFalse(serviceWithNoArtifacts(blackboard).shouldBlockFinalWrite(warnings),
                "抓取失败、结论缺证据都不值得让用户拿不到回答 —— 它们进回答提示词让模型收敛措辞即可。"
                        + "阻断只开「勾了源却零证据」一个口子");
    }

    @Test
    void 编造的引用必须被标出() {
        RecordingBlackboard blackboard = new RecordingBlackboard();
        List<Map<String, Object>> cited = new ArrayList<>();
        cited.add(citation("https://example.com/real"));
        cited.add(citation("https://example.com/invented"));

        List<AiVerifierFinding> findings = serviceWithNoArtifacts(blackboard)
                .verifyAnswerCitations(1L, cited, Set.of("https://example.com/real"));

        assertEquals(1, findings.size(),
                "模型带出的来源不在本轮实际取到的证据里就必须标出 —— 否则开了联网的模型可以回一个"
                        + "我们从没抓过的 URL，前端照样当作「资料来源」显示。实际：" + findings);
        assertEquals("CITATION_NOT_IN_EVIDENCE", findings.get(0).getCode());
        assertTrue(findings.get(0).getMessage().contains("invented"), "提示里应点名是哪一条对不上");
    }

    @Test
    void 真实引用不得被误标() {
        RecordingBlackboard blackboard = new RecordingBlackboard();
        List<Map<String, Object>> cited = new ArrayList<>();
        cited.add(citation("https://example.com/real"));
        cited.add(citation("https://example.com/also-real"));

        List<AiVerifierFinding> findings = serviceWithNoArtifacts(blackboard).verifyAnswerCitations(
                1L, cited, Set.of("https://example.com/real", "https://example.com/also-real"));

        assertTrue(findings.isEmpty(),
                "引用都在证据集里时不得报警 —— 没有这一条，「一律标记」也能让上一条判据绿。实际：" + findings);
    }

    private static Map<String, Object> citation(String url) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("url", url);
        row.put("title", "t");
        return row;
    }
}
