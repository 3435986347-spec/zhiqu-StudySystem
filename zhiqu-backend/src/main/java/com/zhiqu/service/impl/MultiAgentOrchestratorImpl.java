package com.zhiqu.service.impl;

import com.zhiqu.entity.AiAgentRun;
import com.zhiqu.entity.AiAgentTask;
import com.zhiqu.service.AgentTaskGraphService;
import com.zhiqu.service.MultiAgentOrchestrator;
import com.zhiqu.service.agent.AgentPlanDecision;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 按意图判定造任务图。
 *
 * <p><b>不再自己判定意图</b>：判定收在 {@link AgentPlanDecision}，建图与执行读同一个对象。
 * 此前这里有一套 {@code shouldPlan / shouldDraftTasks / shouldCurateWiki}，
 * {@code AiServiceImpl} 另有一套 {@code shouldRunPlanner / shouldRunRetriever}，
 * 两套已经分叉且方向相反 —— 分歧清单与裁决记在 {@link AgentPlanDecision} 的类注释里。
 */
@Service
public class MultiAgentOrchestratorImpl implements MultiAgentOrchestrator {
    private final AgentTaskGraphService taskGraphService;

    public MultiAgentOrchestratorImpl(AgentTaskGraphService taskGraphService) {
        this.taskGraphService = taskGraphService;
    }

    @Override
    public List<AiAgentTask> plan(AiAgentRun run, AgentPlanDecision decision, Long notebookId) {
        List<AiAgentTask> tasks = new ArrayList<>();

        AiAgentTask orchestrator = taskGraphService.createTask(
                run.getId(), null, "ORCHESTRATOR", "PLAN_TASK_GRAPH", 0,
                null, List.of(), Map.of("agentMode", decision.mode()), "Plan task graph");
        tasks.add(orchestrator);

        if (decision.needsNotebook()) {
            tasks.add(taskGraphService.createTask(run.getId(), orchestrator.getId(), "NOTEBOOK_RESEARCHER",
                    "RESEARCH_NOTEBOOK", 10, "research", List.of(orchestrator.getId()),
                    Map.of("notebookId", notebookId), "Search current Notebook"));
        }
        if (!"CHAT_ONLY".equals(decision.mode()) && decision.includeWiki()) {
            tasks.add(taskGraphService.createTask(run.getId(), orchestrator.getId(), "WIKI_RESEARCHER",
                    "RESEARCH_WIKI", 11, "research", List.of(orchestrator.getId()),
                    Map.of(), "Search selected Wiki pages"));
        }
        if (decision.needsWeb()) {
            tasks.add(taskGraphService.createTask(run.getId(), orchestrator.getId(), "WEB_RESEARCHER",
                    "RESEARCH_WEB", 12, "research", List.of(orchestrator.getId()),
                    Map.of("allowWebSearch", true), "Search web sources"));
        }
        // 兜底 RETRIEVER：needsRetriever 为真但上面三种专职 researcher 一个都没造出来时补一个。
        // 只勾了资料源（selectedSourceIds）而没开 Wiki / Notebook / 联网，走的正是这条 ——
        // 此前 needsRetriever 在建图侧漏掉了那一项，于是检索真的跑了、图里却没有节点（隐形 agent）。
        if (decision.needsRetriever() && tasks.stream().noneMatch(item -> item.getAgentType().endsWith("_RESEARCHER"))) {
            tasks.add(taskGraphService.createTask(run.getId(), orchestrator.getId(), "RETRIEVER",
                    "RESEARCH_CONTEXT", 13, "research", List.of(orchestrator.getId()),
                    Map.of(), "Search available context"));
        }

        if (decision.needsPlanner()) {
            tasks.add(taskGraphService.createTask(run.getId(), orchestrator.getId(), "PLANNER",
                    "PLAN_DRAFT", 30, null, List.of(orchestrator.getId()),
                    Map.of(), "Draft plan"));
        }
        if (decision.needsTaskDraft()) {
            tasks.add(taskGraphService.createTask(run.getId(), orchestrator.getId(), "TASK_DRAFTER",
                    "TASK_DRAFT", 31, null, List.of(orchestrator.getId()),
                    Map.of(), "Draft tasks and routines"));
        }
        if (decision.needsWikiCurator()) {
            tasks.add(taskGraphService.createTask(run.getId(), orchestrator.getId(), "WIKI_CURATOR",
                    "WIKI_DRAFT", 32, null, List.of(orchestrator.getId()),
                    Map.of(), "Draft Wiki patch"));
        }

        tasks.add(taskGraphService.createTask(run.getId(), orchestrator.getId(), "VERIFIER",
                "VERIFY_OUTPUT", 80, null, List.of(orchestrator.getId()), Map.of(), "Verify claims and artifacts"));
        tasks.add(taskGraphService.createTask(run.getId(), orchestrator.getId(), "FINAL_WRITER",
                "FINAL_RESPONSE", 90, null, List.of(orchestrator.getId()), Map.of(), "Generate final answer"));
        return tasks;
    }
}
