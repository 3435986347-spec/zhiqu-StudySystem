package com.zhiqu.rag;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 「一条候选掉了，而这次检索成功」必须可观测。
 *
 * <p>检索侧是<b>第一次让解密进入同步的用户请求路径</b>：Wiki 单元的候选回填要走
 * {@code UnitContentResolver} → 解密 → 按 code point 切片。由此出现一种此前不存在的失效：
 * 某一条候选回填失败（一页密文坏了，{@code DECRYPT_FAILED} 在生产里发生过），
 * 而整次检索仍然可用。
 *
 * <p>它<b>落不进回落记账模型</b>：{@code fallback(...)} 是每次检索一次、二值的，
 * 而这里检索是可用的，只是少了一块。不专门记的话，三层同时看不见 ——
 * 模型少一份资料、指标不动、日志没有。这是本仓库那族缺陷的第五种形态，
 * 只是这次不是忘了接线，是<b>记账粒度接不住</b>。
 *
 * <p>三个选项里取的是「单独计数」而不是「降级成整次回落」：后者最响亮，
 * 但代价是<b>一页坏密文让所有检索退化成关键词</b> —— 一个局部故障放大成全局降级。
 */
class RagDroppedCandidateMetricsTest {

    @Test
    void 按命名空间与原因分别计数() {
        RagMetricsService metrics = new RagMetricsService();

        metrics.recordDroppedCandidate(RagNamespace.WIKI_PAGE, "DECRYPT_FAILED");
        metrics.recordDroppedCandidate(RagNamespace.WIKI_PAGE, "DECRYPT_FAILED");
        metrics.recordDroppedCandidate(RagNamespace.NOTEBOOK_SOURCE, "CHUNK_MISSING");

        Map<String, Long> dropped = droppedOf(metrics);
        assertEquals(2L, dropped.get("WIKI_PAGE:DECRYPT_FAILED"),
                "命名空间是 Wiki 接进来之后最需要的诊断维度：哪一类在掉");
        assertEquals(1L, dropped.get("NOTEBOOK_SOURCE:CHUNK_MISSING"));
        assertEquals(3L, metrics.snapshot().get("droppedCandidateCount"));
    }

    /**
     * 掉候选<b>不是</b>回落 —— 两个计数互不串台。
     *
     * <p>串台的两个方向都坏：掉候选记进 fallback，会让「检索不可用」的计数虚高，
     * 把真正的全局故障淹掉；反过来漏记，就回到了什么都看不见。
     */
    @Test
    void 掉候选不计入回落() {
        RagMetricsService metrics = new RagMetricsService();

        metrics.recordDroppedCandidate(RagNamespace.WIKI_PAGE, "DECRYPT_FAILED");

        assertEquals(0L, metrics.snapshot().get("fallbackCount"),
                "这次检索是成功的，只是少了一条候选；记成回落会把全局故障的计数污染掉");
        assertEquals(1L, metrics.snapshot().get("droppedCandidateCount"));
    }

    /**
     * 跨作用域丢弃走<b>同一个</b>计数器，旧快照键由它派生。
     *
     * <p>另起一个 {@code AtomicLong} 就是第二处记账 —— 而「同一件事有两处记账」
     * 正是这一整轮反复在收敛的形状。旧的两个键前端在读，所以保留，但不再独立。
     */
    @Test
    void 跨作用域丢弃与掉候选是同一个计数器() {
        RagMetricsService metrics = new RagMetricsService();

        metrics.recordCrossScopeDrop();
        metrics.recordCrossScopeDrop();

        Map<String, Object> snapshot = metrics.snapshot();
        assertEquals(2L, snapshot.get("crossScopeDrops"));
        assertEquals(2L, snapshot.get("crossScopeCandidateDropped"));
        assertEquals(2L, snapshot.get("droppedCandidateCount"),
                "两个旧键必须是同一个计数器的派生视图，不是另一处独立记账");
        assertTrue(droppedOf(metrics).containsKey("UNKNOWN:CROSS_SCOPE"),
                "跨作用域丢弃时命名空间本来就未知 —— 记成 UNKNOWN 而不是编一个");
    }

    @SuppressWarnings("unchecked")
    private Map<String, Long> droppedOf(RagMetricsService metrics) {
        return (Map<String, Long>) metrics.snapshot().get("droppedCandidates");
    }
}

// ── 扰动记录（三条性质三次扰动，实测）────────────────────────────────────
//
//   M1  丢弃计数忽略命名空间                      RED
//   M2  掉候选同时记进 fallback                    RED
//   M3  跨作用域丢弃另起一个独立计数器             RED
//
// M3 值得说明：它扰动的不是「数得对不对」，是「有没有第二处记账」。
// 独立计数器下三个断言里有两个仍然通过（旧快照键照样是 2），
// 红在 droppedCandidateCount —— 也就是说这条判据钉的是**同一件事只有一处来源**，
// 而不是某个具体数值。
