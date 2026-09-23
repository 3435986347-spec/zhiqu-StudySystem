package com.zhiqu.service.ai;

/**
 * code agent 工具循环的预算：最多几轮、最多多久。
 *
 * <p>两档，按「是谁把它拉起来的」分：
 * <ul>
 *   <li><b>关键词触发</b>：4 轮 / 30 秒。关键词门是刻意过触发的（见 {@code AgentPlanDecision.codeIntent}），
 *       「今天写了三小时代码」也会拉起它 —— 过触发必须便宜，所以预算要小。</li>
 *   <li><b>用户显式按下「代码」</b>（或者从 CLI 来）：10 轮 / 180 秒。他明说了要它干活，
 *       「读几个文件 → 写一个完整的小游戏」在 4 轮 30 秒里做不完 —— 2026-09-23 之前
 *       只有前一档，它对显式请求来说是个会半途而废的上限。</li>
 * </ul>
 *
 * <p>显式档的时长必须小于整条流的超时（{@code AiWorkspaceService.STREAM_TIMEOUT_MS}，5 分钟）：
 * 循环跑完之后还要写最终回答。{@code CodeLoopBudgetTest} 钉着这条。
 */
public record CodeLoopBudget(int rounds, long millis, int maxTokensPerCall, int callTimeoutCapMillis) {

    public static final CodeLoopBudget KEYWORD = new CodeLoopBudget(4, 30_000L, 4096, 25_000);
    /**
     * 16384 token：一整个单文件小游戏（HTML + CSS + JS，带中文注释）要四五千 token，
     * 推理型模型还要先花 token 想。4096 是 2026-09-23 那次「写马里奥」被截断的原因之一。
     */
    public static final CodeLoopBudget EXPLICIT = new CodeLoopBudget(10, 180_000L, 16384, 150_000);

    public static CodeLoopBudget forRequest(boolean explicitCodeMode) {
        return explicitCodeMode ? EXPLICIT : KEYWORD;
    }

    /**
     * 这一次模型调用的限额：读超时取「单次上限」和「剩余预算」中小的那个（至少 5 秒）。
     *
     * <p>不能直接给单次上限：预算只在每一轮<b>开头</b>检查，第 179 秒开始的一轮若能再等 150 秒，
     * 整个循环会跑到 329 秒 —— 越过整条流 300 秒的超时，最终回答永远出不来。
     */
    public ModelProviderClient.ToolTurnLimits turnLimits(long elapsedMillis) {
        long remaining = millis - elapsedMillis;
        int timeout = (int) Math.max(5_000L, Math.min(callTimeoutCapMillis, remaining));
        return new ModelProviderClient.ToolTurnLimits(maxTokensPerCall, timeout);
    }
}
