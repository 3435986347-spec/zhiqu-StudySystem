package com.zhiqu.service.agent;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.Set;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

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

        /** 只有 RUN 参与并发；宣告与落库始终顺序执行（理由见 AgentStageRunner.parallelGroup）。 */
        String concurrentGroup() {
            return moment == Moment.RUN ? runner.parallelGroup() : null;
        }

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
     * 每个 agentType 的<b>真实执行次序</b>（按 run 位置排名，从 0 起）与所属并发组。
     *
     * <p>给建图侧派生 {@code priority} / {@code parallel_group_id} / {@code depends_on} 用。
     * 那三个字段<b>不参与调度</b> —— 次序的唯一权威仍是 {@link AgentPosition}，
     * 它们是它的投影，只供执行轨迹画图。让它们成为独立来源就是本仓库反复在消灭的
     * 「同一事实两个真相」，而在派生之前，那三个字段确实都已经和执行对不上了。
     *
     * <p>同组的成员排名相同：它们并发，彼此之间没有先后。
     */
    public List<RunSlot> runOrder() {
        List<Action> runs = new ArrayList<>();
        for (Action action : actions) {
            if (action.moment() == Moment.RUN) {
                runs.add(action);
            }
        }
        List<RunSlot> slots = new ArrayList<>();
        Map<String, Integer> rankByGroup = new LinkedHashMap<>();
        int rank = -1;
        String previousGroupKey = null;
        for (Action action : runs) {
            String group = action.runner().parallelGroup();
            String key = group == null ? "\u0000" + action.runner().agentType() : group;
            if (!key.equals(previousGroupKey)) {
                Integer seen = rankByGroup.get(key);
                if (seen != null) {
                    // 组成员在位置上不连续：中间夹着别的 runner。执行器仍会把它们批在一起跑
                    // （同组动作是收集来的，不要求相邻），于是夹在中间那个的「先后」就说不清了 ——
                    // 它既在前一个成员之后，又在后一个成员之前，而那两个是同时的。
                    // 与抢位置一样，这是配置错误，宁可启动就炸。
                    throw new IllegalStateException(group == null
                            ? "同一个 agentType 出现在两个不相邻的位置上：" + action.runner().agentType()
                                    + "。一个 agentType 只该有一个 run 位置"
                            : "并发组 " + group + " 的成员在位置上不连续，中间夹着别的 runner："
                                    + action.runner().agentType() + " 之前已经出现过该组。"
                                    + "把同组成员排到相邻的位置上");
                }
                rank++;
                rankByGroup.put(key, rank);
                previousGroupKey = key;
            }
            slots.add(new RunSlot(action.runner().agentType(), rank, group));
        }
        return List.copyOf(slots);
    }

    /** 一个 runner 在真实执行序里的位置：rank 相同即并发。 */
    public record RunSlot(String agentType, int rank, String parallelGroup) {
    }

    /**
     * 跑完这一相位上的全部动作。
     *
     * <p>遍历期间 {@link AgentRunContext#emit} 按<b>这个相位</b>路由；
     * 退出时把相位还原，所以遍历之外（比如事务提交后的收尾）的 emit 一律直发。
     */
    public void execute(AgentPhase phase, AgentRunContext ctx) {
        execute(phase, ctx, 1);
    }

    /**
     * 跑完这一相位上的全部动作，同组的 {@code run} 并发执行。
     *
     * @param maxParallel 并发上限（来自 {@code ai_agent_run.max_parallel_tasks}）；
     *        ≤1 时退化为顺序执行，行为与并发前完全一致。
     *
     * <p><b>一个并发组占据其最早成员的位置。</b>组跑完之后才继续推进 ——
     * 所以夹在组成员位置之间的非组动作会排到组之后，而不是插在组中间。
     * 并发本来就没有组内次序，依赖组内次序的东西不该放进同一个组。
     */
    public void execute(AgentPhase phase, AgentRunContext ctx, int maxParallel) {
        AgentPhase previous = ctx.enterPhase(phase);
        try {
            List<Action> due = new ArrayList<>();
            for (Action action : actions) {
                if (action.position().phase() == phase) {
                    due.add(action);
                }
            }
            // 同组的 RUN 在排序后<b>并不相邻</b>：排序键是 (位置, 时刻)，
            // 于是 A 的 RUN 与 B 的 RUN 中间隔着 A 的 COMMIT 与 B 的 ANNOUNCE。
            // 按「连续同组」收批的话每批只有一个，并发等于没有 —— 判据第一次跑就逮到了这个。
            // 所以按组名收集，整组在<b>最早那个成员的位置</b>上一起跑，其余成员到位时跳过。
            Set<Action> consumed = new HashSet<>();
            for (Action action : due) {
                if (consumed.contains(action)) {
                    continue;
                }
                String group = action.concurrentGroup();
                if (group == null || maxParallel <= 1) {
                    action.invoke(ctx);
                    continue;
                }
                List<Action> batch = new ArrayList<>();
                for (Action candidate : due) {
                    if (group.equals(candidate.concurrentGroup())) {
                        batch.add(candidate);
                    }
                }
                consumed.addAll(batch);
                runConcurrently(batch, ctx, maxParallel);
            }
        } finally {
            ctx.enterPhase(previous);
        }
    }

    /**
     * 并发跑一批动作，等全部结束再返回。
     *
     * <p><b>任何一条抛出都要原样抛出去</b>：检索阶段的 BusinessException（比如「选择的资料不存在」）
     * 是要中断整轮的，被并发包装吞掉或换成 ExecutionException 都会让上层的错误路径认不出它。
     */
    private void runConcurrently(List<Action> batch, AgentRunContext ctx, int maxParallel) {
        if (batch.size() == 1) {
            batch.get(0).invoke(ctx);
            return;
        }
        ExecutorService pool = Executors.newFixedThreadPool(Math.min(batch.size(), maxParallel));
        try {
            List<Future<?>> futures = new ArrayList<>();
            for (Action action : batch) {
                futures.add(pool.submit(() -> {
                    action.invoke(ctx);
                    return null;
                }));
            }
            RuntimeException failure = null;
            for (Future<?> future : futures) {
                try {
                    future.get();
                } catch (ExecutionException e) {
                    Throwable cause = e.getCause();
                    // 只记第一个失败，但仍要等完其余的 —— 否则线程池关掉时还有 runner 在写库
                    if (failure == null) {
                        failure = cause instanceof RuntimeException runtime
                                ? runtime
                                : new IllegalStateException(cause);
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException("并发检索被中断", e);
                }
            }
            if (failure != null) {
                throw failure;
            }
        } finally {
            pool.shutdown();
        }
    }
}
