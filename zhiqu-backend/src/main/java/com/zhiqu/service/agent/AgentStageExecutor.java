package com.zhiqu.service.agent;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 图驱动执行器：把每个 runner 的三个动作摊平成 {@code (位置, 动作)}，<b>排一次序</b>，按相位遍历。
 *
 * <p>此前次序由 {@code streamChatInternal} 里几百行语句的书写顺序决定，图只是记录：
 * 图里 {@code VERIFIER=80}、{@code PLANNER=30}，实际执行却是 VERIFIER 在前 ——
 * <b>声明的 order 没有消费者</b>。摊平排序之后，声明的位置就是唯一的次序来源。
 */
public final class AgentStageExecutor {

    /** 同一位置上三个动作的固定先后。 */
    private enum Moment { ANNOUNCE, RUN, COMMIT }

    private record Action(AgentPosition position, Moment moment, AgentStageRunner runner) {

        void invoke(AgentRunContext ctx) {
            boolean inGraph = runner.inGraph(ctx);
            switch (moment) {
                // 宣告是唯一在「节点不在图里」时也要发声的动作：用户要看到「本轮不需要计划草稿」。
                case ANNOUNCE -> {
                    if (inGraph) {
                        runner.announce(ctx);
                    } else {
                        runner.announceSkipped(ctx);
                    }
                }
                // 工作与落库只在节点真的在图里时才跑 —— 「跑了却没造节点」在这里写不出来。
                case RUN -> {
                    if (inGraph) {
                        runner.run(ctx);
                    }
                }
                case COMMIT -> {
                    if (inGraph) {
                        runner.commit(ctx);
                    }
                }
            }
        }
    }

    private final List<Action> actions;

    public AgentStageExecutor(List<AgentStageRunner> runners) {
        List<Action> collected = new ArrayList<>();
        for (AgentStageRunner runner : runners) {
            collected.add(new Action(runner.announceAt(), Moment.ANNOUNCE, runner));
            collected.add(new Action(runner.runAt(), Moment.RUN, runner));
            collected.add(new Action(runner.commitAt(), Moment.COMMIT, runner));
        }
        collected.sort(Comparator.comparing(Action::position).thenComparing(Action::moment));
        rejectAmbiguousSlots(collected);
        this.actions = List.copyOf(collected);
    }

    /**
     * 两个 runner 抢同一个 {@code (相位, 次序, 动作)} 槽位就是配置错误：谁先谁后只剩下注册顺序决定，
     * 而注册顺序正是这次要消灭的那种隐式依赖。宁可启动就炸。
     */
    private static void rejectAmbiguousSlots(List<Action> collected) {
        Map<String, String> claimed = new LinkedHashMap<>();
        for (Action action : collected) {
            String slot = action.position() + "/" + action.moment();
            String previous = claimed.putIfAbsent(slot, action.runner().agentType());
            if (previous != null && !previous.equals(action.runner().agentType())) {
                throw new IllegalStateException(
                        "两个 runner 抢同一个位置 " + slot + "：" + previous + " 与 " + action.runner().agentType()
                                + "。位置必须唯一，否则次序又回到注册顺序决定");
            }
        }
    }

    /**
     * 跑完这一相位上的全部动作。
     *
     * <p>遍历期间 {@link AgentRunContext#emit} 按<b>这个相位</b>路由；
     * 退出时把相位还原，所以遍历之外（比如事务提交后的收尾）的 emit 一律直发。
     */
    public void execute(AgentPhase phase, AgentRunContext ctx) {
        AgentPhase previous = ctx.enterPhase(phase);
        try {
            for (Action action : actions) {
                if (action.position().phase() == phase) {
                    action.invoke(ctx);
                }
            }
        } finally {
            ctx.enterPhase(previous);
        }
    }
}
