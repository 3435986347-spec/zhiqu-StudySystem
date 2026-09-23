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
public record CodeLoopBudget(int rounds, long millis) {

    public static final CodeLoopBudget KEYWORD = new CodeLoopBudget(4, 30_000L);
    public static final CodeLoopBudget EXPLICIT = new CodeLoopBudget(10, 180_000L);

    public static CodeLoopBudget forRequest(boolean explicitCodeMode) {
        return explicitCodeMode ? EXPLICIT : KEYWORD;
    }
}
