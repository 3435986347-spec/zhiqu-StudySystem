package com.zhiqu.service.agent;

import com.zhiqu.entity.AiAgentTask;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BiConsumer;

/**
 * 一次 run 的执行上下文 —— runner 能看到的<b>全部</b>对外通道。
 *
 * <h2>唯一的出事件方式是 {@link #emit}</h2>
 *
 * <p>裸 emitter 与缓冲队列<b>都不暴露</b>。此前编排层有两套平行的辅助方法，
 * 差别只在往哪个通道发（{@code startTask} / {@code startTaskTx}、
 * {@code completeTask} / {@code completeTaskTx}、{@code completeStep} / {@code completeStepTx}…），
 * 于是「在事务里错用了直发那一支」是随手就能写出来的 bug，而且它<b>不会当场暴露</b>：
 * 只有事务回滚时前端才会收到指向不存在数据的事件。收成一个 {@code emit} 之后这个错写不出来了。
 *
 * <h2>路由按「遍历正处的相位」，不按 runner 声明的相位</h2>
 *
 * <p>这一条是<b>刻意</b>的，不是省事。PLANNER 声明
 * {@code runAt() = POST_STREAM}、{@code commitAt() = COMMIT}、{@code announceAt() = PRE_STREAM}；
 * 若按 runner 声明的相位路由，得先问「按哪一个」，而无论选哪个都会有一个动作走错通道 ——
 * 比如按 {@code commitAt()} 路由，PLANNER 的宣告就会被塞进缓冲、等事务提交后才发，
 * 恰好抵消 {@code announceAt()} 存在的理由，用户在整个流式期间看不到「正在准备计划草稿」。
 * 按遍历所处的相位路由则不需要问：<b>动作此刻在哪，就用哪个通道</b>。
 */
public final class AgentRunContext {

    private final List<AiAgentTask> tasks;
    private final Map<String, AiAgentTask> byType = new LinkedHashMap<>();
    private final BiConsumer<String, Object> directChannel;
    private final List<AgentSseEvent> deferred = new ArrayList<>();

    /** 当前遍历所处的相位；不在遍历中时为 null（此时 emit 直发）。只有 executor 能改。 */
    private AgentPhase phase;

    public AgentRunContext(List<AiAgentTask> tasks, BiConsumer<String, Object> directChannel) {
        this.tasks = tasks == null ? List.of() : List.copyOf(tasks);
        this.directChannel = directChannel;
        for (AiAgentTask task : this.tasks) {
            if (task != null && task.getAgentType() != null) {
                byType.putIfAbsent(task.getAgentType(), task);
            }
        }
    }

    /**
     * 发一条事件。<b>COMMIT 相位进缓冲，其余相位直发</b> —— 判断依据是当前遍历相位，
     * 不是调用方声明的相位（理由见类注释）。
     */
    public void emit(String name, Object payload) {
        if (phase == AgentPhase.COMMIT) {
            deferred.add(new AgentSseEvent(name, payload));
            return;
        }
        directChannel.accept(name, payload);
    }

    /** 图里这个类型的节点；没有则 null。 */
    public AiAgentTask task(String agentType) {
        return byType.get(agentType);
    }

    /** 图里是否有这些类型中的任意一个节点。 */
    public boolean hasAnyTask(String... agentTypes) {
        for (String agentType : agentTypes) {
            if (byType.containsKey(agentType)) {
                return true;
            }
        }
        return false;
    }

    public List<AiAgentTask> tasks() {
        return tasks;
    }

    /** 当前遍历相位；不在遍历中时为 null。 */
    public AgentPhase phase() {
        return phase;
    }

    /** 事务提交后由编排层补发的缓冲事件。回滚时不发。 */
    public List<AgentSseEvent> deferredEvents() {
        return List.copyOf(deferred);
    }

    /** 只给同包的 {@link AgentStageExecutor} 用。 */
    AgentPhase enterPhase(AgentPhase next) {
        AgentPhase previous = phase;
        phase = next;
        return previous;
    }
}
