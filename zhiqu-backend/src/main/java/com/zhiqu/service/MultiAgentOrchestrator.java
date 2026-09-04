package com.zhiqu.service;

import com.zhiqu.entity.AiAgentRun;
import com.zhiqu.entity.AiAgentTask;
import com.zhiqu.service.agent.AgentPlanDecision;

import java.util.List;

public interface MultiAgentOrchestrator {
    /**
     * 按已算好的意图判定造任务图。
     *
     * <p><b>判定由调用方传入，不在这里算</b>：执行侧要用同一个 {@link AgentPlanDecision}
     * 决定跑不跑，两边各算一次就是「同一事实两份拷贝」，而那两套此前已经分叉。
     */
    List<AiAgentTask> plan(AiAgentRun run, AgentPlanDecision decision, Long notebookId);
}
