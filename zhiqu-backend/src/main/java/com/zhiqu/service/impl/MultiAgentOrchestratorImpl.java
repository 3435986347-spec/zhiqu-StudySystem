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

        // NOTEBOOK 与 WIKI 合成一个节点：它们不是两个可独立调度的单元 ——
        // AiWorkspaceServiceImpl.sourceContext 一次 RAG 调用同时覆盖 Notebook 资料与 Wiki 页
        // （Wiki 在 SourceScopeResolver 返回的 ScopeSelection 里，带页数上界）。
        // 此前建图侧造两个节点，执行侧只有一次调用，于是图声称了一个执行里没有的结构 ——
        // 与幽灵/隐形 agent 同一个物种，只是方向是「多声称了一个」。
        //
        // 另一条路是把 RAG 调用拆成 notebook-only 与 wiki-only 两次以凑够两个单元，
        // 为了建模美观多花一次向量检索，不做。
        if (decision.needsNotebook() || (!"CHAT_ONLY".equals(decision.mode()) && decision.includeWiki())) {
            tasks.add(taskGraphService.createTask(run.getId(), orchestrator.getId(), "CONTEXT_RESEARCHER",
                    "RESEARCH_CONTEXT_SOURCES", 10, "research", List.of(orchestrator.getId()),
                    Map.of("notebookId", notebookId == null ? "" : notebookId), "Search Notebook and Wiki"));
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

        // Wiki 工具循环在最终回答【之前】跑，所以排在 researcher 之后、草稿类之前
        if (decision.needsWikiTool()) {
            tasks.add(taskGraphService.createTask(run.getId(), orchestrator.getId(), "WIKI_TOOL_AGENT",
                    "WIKI_TOOL_LOOP", 20, null, List.of(orchestrator.getId()),
                    Map.of(), "Read and edit Wiki via tools"));
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

        if (decision.needsPlanExtractor()) {
            tasks.add(taskGraphService.createTask(run.getId(), orchestrator.getId(), "PLAN_EXTRACTOR",
                    "EXTRACT_PLAN", 34, null, List.of(orchestrator.getId()),
                    Map.of(), "Extract a structured plan draft"));
        }
        if (decision.needsMemoryDraft()) {
            tasks.add(taskGraphService.createTask(run.getId(), orchestrator.getId(), "MEMORY_CURATOR",
                    "MEMORY_DRAFT", 33, null, List.of(orchestrator.getId()),
                    Map.of(), "Draft long-term memory"));
        }

        tasks.add(taskGraphService.createTask(run.getId(), orchestrator.getId(), "VERIFIER",
                "VERIFY_OUTPUT", 80, null, List.of(orchestrator.getId()), Map.of(), "Verify claims and artifacts"));
        if (decision.needsSummary()) {
            tasks.add(taskGraphService.createTask(run.getId(), orchestrator.getId(), "SUMMARIZER",
                    "COMPRESS_HISTORY", 35, null, List.of(orchestrator.getId()),
                    Map.of(), "Compress older conversation turns"));
        }
        if (decision.needsAnswerVerifier()) {
            tasks.add(taskGraphService.createTask(run.getId(), orchestrator.getId(), "ANSWER_VERIFIER",
                    "VERIFY_ANSWER_CITATIONS", 91, null, List.of(orchestrator.getId()),
                    Map.of(), "Check answer citations against evidence"));
        }
        tasks.add(taskGraphService.createTask(run.getId(), orchestrator.getId(), "FINAL_WRITER",
                "FINAL_RESPONSE", 90, null, List.of(orchestrator.getId()), Map.of(), "Generate final answer"));
        return tasks;
    }
}
