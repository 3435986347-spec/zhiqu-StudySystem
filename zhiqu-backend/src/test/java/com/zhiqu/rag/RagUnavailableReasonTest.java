package com.zhiqu.rag;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 「未启用」与「启用了但没配 token」必须是两个可区分的信号。
 *
 * <p>此前它们共用一个字符串 {@code DISABLED_OR_TOKEN_MISSING} —— 名字里的 {@code OR}
 * 自己承认了合并。识别点可复用：<b>标识符里出现 OR，而两边本该走不同分支</b>
 * （同族的另一个是 {@code PAGE_NOT_FOUND_OR_NOT_OWNED}，见 {@code UnitContent.Outcome.GONE}）。
 *
 * <p>为什么值得单独修：这个字符串经 {@code RagClient.meta()} 的 {@code ready/reason}
 * 进了运维可见的健康信息，而 cutover runbook 的最后一步正是把 {@code app.rag.enabled}
 * 翻成 true —— 整条链路唯一一次全量检验。翻完开关却忘了配 token 的人，
 * 看到的提示与「你压根没开」完全一样，于是回头去查刚翻过的那个开关。
 * <b>诊断信号在最需要它的那一步是合并的</b>，而修它是一行的事。
 */
class RagUnavailableReasonTest {

    private static RagProperties properties(boolean enabled, String token) {
        RagProperties properties = new RagProperties();
        properties.setEnabled(enabled);
        properties.setServiceToken(token);
        return properties;
    }

    @Test
    void 三种状态各自可区分() {
        assertEquals(RagClient.REASON_DISABLED,
                new RagClient(properties(false, "a-real-token")).unavailableReason(),
                "开关关着就是 DISABLED —— 哪怕 token 配好了");
        assertEquals(RagClient.REASON_TOKEN_MISSING,
                new RagClient(properties(true, "   ")).unavailableReason(),
                "开着却没有可用 token 是配置错误，不能和「没开」共用一个信号");
        assertEquals(RagClient.REASON_TOKEN_MISSING,
                new RagClient(properties(true, null)).unavailableReason());
        assertNull(new RagClient(properties(true, "a-real-token")).unavailableReason());
    }

    /** 运维看到的那一层必须跟着分开 —— 合并就发生在这里。 */
    @Test
    void 健康信息里的reason跟着分开() {
        Map<String, Object> disabled = new RagClient(properties(false, "a-real-token")).meta();
        Map<String, Object> tokenMissing = new RagClient(properties(true, null)).meta();

        assertEquals(false, disabled.get("ready"));
        assertEquals(RagClient.REASON_DISABLED, disabled.get("reason"));
        assertEquals(RagClient.REASON_TOKEN_MISSING, tokenMissing.get("reason"));
    }

    /** {@code configured()} 的语义不变：三种不可用都是 false。 */
    @Test
    void configured仍然是三种状态的合取() {
        assertFalse(new RagClient(properties(false, "a-real-token")).configured());
        assertFalse(new RagClient(properties(true, null)).configured());
        assertTrue(new RagClient(properties(true, "a-real-token")).configured());
    }

    /**
     * <b>两者的差别不止于文案，行为也不同</b>：TOKEN_MISSING 记进 fallback 指标，DISABLED 不记。
     *
     * <p>DISABLED 是仓库默认状态，记进去只会把指标刷满、淹掉真正的回落原因；
     * TOKEN_MISSING 是「开着却不工作」，必须留下痕迹。让两者行为不同，
     * 这次拆分才是承重的 —— 否则它随时可以被合回去而没有任何东西会红。
     */
    @Test
    void 只有配置错误计入回落指标() {
        RagMetricsService disabledMetrics = new RagMetricsService();
        retrieverWith(properties(false, "a-real-token"), disabledMetrics)
                .retrieve("req-1", 1L, 1L, new ScopeSelection(1L, 1L, java.util.List.of()), "问题");

        RagMetricsService brokenMetrics = new RagMetricsService();
        RagRetriever.RetrievalResult broken = retrieverWith(properties(true, null), brokenMetrics)
                .retrieve("req-2", 1L, 1L, new ScopeSelection(1L, 1L, java.util.List.of()), "问题");

        assertEquals(RagClient.REASON_TOKEN_MISSING, broken.fallbackReason());
        assertTrue(fallbackCount(disabledMetrics).isEmpty(),
                "未启用是设计内的正常状态，刷进指标只会淹掉真正的回落原因");
        assertEquals(1L, fallbackCount(brokenMetrics).get(RagClient.REASON_TOKEN_MISSING),
                "开着却没配 token 必须留下痕迹");
    }

    private RagRetriever retrieverWith(RagProperties properties, RagMetricsService metrics) {
        return new RagRetriever(properties, new RagClient(properties),
                org.mockito.Mockito.mock(com.zhiqu.mapper.RagIndexGenerationMapper.class),
                org.mockito.Mockito.mock(com.zhiqu.mapper.RagSourceIndexStateMapper.class),
                metrics);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Long> fallbackCount(RagMetricsService metrics) {
        return (Map<String, Long>) metrics.snapshot().get("fallbacks");
    }
}

// ── 扰动记录（四条性质四次扰动，实测）────────────────────────────────────
//
//   J1  unavailableReason 把两种合回一个                RED
//   J2  meta() 硬编码回旧的合并字符串                    RED
//   J3  configured() 只看 enabled 开关                  RED
//   J4  DISABLED 也记进 fallback 指标                    RED
//
// J4 是这次拆分的**承重点**。只改文案的话，两者仍然只有名字不同，
// 随时可以被合回去而没有任何东西会红 —— 让它们的行为不同，拆分才立得住。
