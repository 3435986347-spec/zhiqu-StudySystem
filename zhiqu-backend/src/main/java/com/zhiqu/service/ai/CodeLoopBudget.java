package com.zhiqu.service.ai;

/**
 * code agent 工具循环的预算：最多几轮、最多多久。
 *
 * <p>两档，按「是谁把它拉起来的」分：
 * <ul>
 *   <li><b>关键词触发</b>：4 轮 / 30 秒。关键词门是刻意过触发的（见 {@code AgentPlanDecision.codeIntent}），
 *       「今天写了三小时代码」也会拉起它 —— 过触发必须便宜，所以预算要小。</li>
 *   <li><b>代码模式（用户选的档位开着）</b>：80 轮 / 600 秒。他明说了要它干活，
 *       「读几个文件 → 写一个完整的小游戏」在 4 轮 30 秒里做不完 —— 2026-09-23 之前
 *       只有前一档，它对显式请求来说是个会半途而废的上限。</li>
 * </ul>
 *
 * <p>显式档的时长必须小于整条流的超时（{@code AiWorkspaceService.STREAM_TIMEOUT_MS}，15 分钟）：
 * 循环跑完之后还要写最终回答。{@code CodeLoopBudgetTest} 钉着这条。
 */
public record CodeLoopBudget(int rounds, long millis, int maxTokensPerCall, int callTimeoutCapMillis) {

    public static final CodeLoopBudget KEYWORD = new CodeLoopBudget(4, 30_000L, 4096, 25_000);
    /**
     * 16384 token：一整个单文件小游戏（HTML + CSS + JS，带中文注释）要四五千 token，
     * 推理型模型还要先花 token 想。4096 是 2026-09-23 那次「写马里奥」被截断的原因之一。
     */
    // 第一百三十六轮：**0 轮 / 0 秒 = 不限**（用户：「每次做到一半，没有完全修复就暂停，下一次又得从头开始，
    // 所以把限时和限轮次去掉吧」）。这一档是用户自己开着代码模式、明说要干活的：做到一半被掐断，
    // 改过的文件、建好的临时脚本全废，下一轮还得从头看一遍 —— 比跑得久难受得多。
    // 兜住死循环的是单次调用的读超时（callTimeoutCapMillis）和「连着重复同一个调用」的检测，不是墙钟。
    // 桌面外壳（LocalAgent.swift）和 JS 宿主（code-host.js）同一个口径：0 = 不限。
    public static final CodeLoopBudget EXPLICIT = new CodeLoopBudget(0, 0L, 16384, 150_000);

    public static CodeLoopBudget forRequest(boolean explicitCodeMode) {
        return explicitCodeMode ? EXPLICIT : KEYWORD;
    }

    /**
     * 这一次模型调用的限额：读超时取「单次上限」和「剩余预算」中小的那个（至少 5 秒）。
     *
     * <p>不能直接给单次上限：预算只在每一轮<b>开头</b>检查，第 179 秒开始的一轮若能再等 150 秒，
     * 整个循环会跑到 329 秒 —— 越过整条流 300 秒的超时，最终回答永远出不来。
     *
     * <p>不限总时长（{@code millis <= 0}）时没有「剩余」可算，单次就按单次上限 —— 一轮想 150 秒是正常的。
     */
    public ModelProviderClient.ToolTurnLimits turnLimits(long elapsedMillis) {
        if (millis <= 0) {
            return new ModelProviderClient.ToolTurnLimits(maxTokensPerCall, callTimeoutCapMillis);
        }
        long remaining = millis - elapsedMillis;
        int timeout = (int) Math.max(5_000L, Math.min(callTimeoutCapMillis, remaining));
        return new ModelProviderClient.ToolTurnLimits(maxTokensPerCall, timeout);
    }

    /** 轮数 / 时长是不是不限（0 表示不限）。 */
    public boolean unlimited() {
        return rounds <= 0 && millis <= 0;
    }
}
