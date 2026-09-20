package com.zhiqu.service;

import com.zhiqu.entity.AiAgentRun;
import com.zhiqu.entity.AiAgentTask;
import com.zhiqu.service.agent.AgentPlanDecision;
import com.zhiqu.service.agent.AgentStageExecutor;

import java.util.List;

public interface MultiAgentOrchestrator {
    /**
     * 按已算好的意图判定造任务图。
     *
     * <p><b>判定由调用方传入，不在这里算</b>：执行侧要用同一个 {@link AgentPlanDecision}
     * 决定跑不跑，两边各算一次就是「同一事实两份拷贝」，而那两套此前已经分叉。
     *
     * <p><b>次序也由调用方传入</b>：{@code runOrder} 来自 {@link AgentStageExecutor#runOrder()}，
     * 即 runner 声明的 {@code AgentPosition} 的投影。建图侧据此派生
     * {@code priority} / {@code parallelGroupId} / {@code dependsOn} 三个字段 ——
     * 手写它们就是让次序有第二个真相，而那三个字段此前都已经和执行对不上了。
     */
    List<AiAgentTask> plan(AiAgentRun run, AgentPlanDecision decision, Long notebookId,
                           List<AgentStageExecutor.RunSlot> runOrder);
}
