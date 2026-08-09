package com.zhiqu.service.impl;

import com.zhiqu.entity.AiAgentRun;
import com.zhiqu.entity.AiAgentTask;
import com.zhiqu.service.ContextOptionKeys;
import com.zhiqu.service.AgentTaskGraphService;
import com.zhiqu.service.MultiAgentOrchestrator;
import org.springframework.stereotype.Service;

import java.util.*;

@Service
public class MultiAgentOrchestratorImpl implements MultiAgentOrchestrator {
    private final AgentTaskGraphService taskGraphService;

    public MultiAgentOrchestratorImpl(AgentTaskGraphService taskGraphService) {
        this.taskGraphService = taskGraphService;
    }

    @Override
    public List<AiAgentTask> plan(AiAgentRun run, String message, String agentMode,
                                  boolean enableWebSearch, Long notebookId, Map<String, Object> contextOptions) {
        String mode = normalizeAgentMode(agentMode);
        Map<String, Object> options = contextOptions == null ? Map.of() : contextOptions;
        List<AiAgentTask> tasks = new ArrayList<>();

        AiAgentTask orchestrator = taskGraphService.createTask(
                run.getId(), null, "ORCHESTRATOR", "PLAN_TASK_GRAPH", 0,
                null, List.of(), Map.of("agentMode", mode), "Plan task graph");
        tasks.add(orchestrator);

        boolean chatOnly = "CHAT_ONLY".equals(mode);
        boolean needsPlan = shouldPlan(mode, message);
        boolean needsTaskDraft = shouldDraftTasks(message);
        boolean needsWikiDraft = shouldCurateWiki(message);
        boolean includeWiki = Boolean.TRUE.equals(options.get(ContextOptionKeys.INCLUDE_WIKI)) || hasNonEmptyList(options.get(ContextOptionKeys.SELECTED_WIKI_PAGE_IDS));
        boolean hasNotebook = notebookId != null;
        boolean needsNotebook = !chatOnly && hasNotebook;
        boolean needsWeb = !chatOnly && enableWebSearch;
        boolean needsRetriever = !chatOnly && ("RESEARCH".equals(mode) || needsNotebook || needsWeb || includeWiki);

        if (needsNotebook) {
            tasks.add(taskGraphService.createTask(run.getId(), orchestrator.getId(), "NOTEBOOK_RESEARCHER",
                    "RESEARCH_NOTEBOOK", 10, "research", List.of(orchestrator.getId()),
                    Map.of("notebookId", notebookId), "Search current Notebook"));
        }
        if (!chatOnly && includeWiki) {
            tasks.add(taskGraphService.createTask(run.getId(), orchestrator.getId(), "WIKI_RESEARCHER",
                    "RESEARCH_WIKI", 11, "research", List.of(orchestrator.getId()),
                    Map.of(), "Search selected Wiki pages"));
        }
        if (needsWeb) {
            tasks.add(taskGraphService.createTask(run.getId(), orchestrator.getId(), "WEB_RESEARCHER",
                    "RESEARCH_WEB", 12, "research", List.of(orchestrator.getId()),
                    Map.of("allowWebSearch", true), "Search web sources"));
        }
        if (needsRetriever && tasks.stream().noneMatch(item -> item.getAgentType().endsWith("_RESEARCHER"))) {
            tasks.add(taskGraphService.createTask(run.getId(), orchestrator.getId(), "RETRIEVER",
                    "RESEARCH_CONTEXT", 13, "research", List.of(orchestrator.getId()),
                    Map.of(), "Search available context"));
        }

        if (needsPlan) {
            tasks.add(taskGraphService.createTask(run.getId(), orchestrator.getId(), "PLANNER",
                    "PLAN_DRAFT", 30, null, List.of(orchestrator.getId()),
                    Map.of(), "Draft plan"));
        }
        if (needsTaskDraft) {
            tasks.add(taskGraphService.createTask(run.getId(), orchestrator.getId(), "TASK_DRAFTER",
                    "TASK_DRAFT", 31, null, List.of(orchestrator.getId()),
                    Map.of(), "Draft tasks and routines"));
        }
        if (needsWikiDraft) {
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

    private boolean shouldPlan(String mode, String message) {
        if ("PLAN".equals(mode)) {
            return true;
        }
        if ("CHAT_ONLY".equals(mode) || "RESEARCH".equals(mode)) {
            return false;
        }
        String text = message == null ? "" : message.toLowerCase(Locale.ROOT);
        return text.contains("计划") || text.contains("安排") || text.contains("任务")
                || text.contains("例行") || text.contains("plan");
    }

    private boolean shouldDraftTasks(String message) {
        String text = message == null ? "" : message.toLowerCase(Locale.ROOT);
        return text.contains("生成任务") || text.contains("写入任务") || text.contains("例行任务")
                || text.contains("task");
    }

    private boolean shouldCurateWiki(String message) {
        String text = message == null ? "" : message.toLowerCase(Locale.ROOT);
        return text.contains("wiki") || text.contains("知识库") || text.contains("知识 wiki")
                || text.contains("写进知识");
    }

    private boolean hasNonEmptyList(Object value) {
        return value instanceof List<?> list && !list.isEmpty();
    }

    private String normalizeAgentMode(String agentMode) {
        String value = agentMode == null ? "AUTO" : agentMode.trim().toUpperCase(Locale.ROOT);
        return Set.of("AUTO", "CHAT_ONLY", "RESEARCH", "PLAN").contains(value) ? value : "AUTO";
    }
}
