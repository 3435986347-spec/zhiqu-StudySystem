package com.zhiqu.service.impl;

import com.zhiqu.entity.AiAgentRun;
import com.zhiqu.entity.AiAgentTask;
import com.zhiqu.service.AgentTaskGraphService;
import com.zhiqu.service.MultiAgentOrchestrator;
import com.zhiqu.service.agent.AgentPlanDecision;
import com.zhiqu.service.agent.AgentStageExecutor;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 按意图判定造任务图。
 *
 * <p><b>不再自己判定意图</b>：判定收在 {@link AgentPlanDecision}，建图与执行读同一个对象。
 * 此前这里有一套 {@code shouldPlan / shouldDraftTasks / shouldCurateWiki}，
 * {@code AiServiceImpl} 另有一套 {@code shouldRunPlanner / shouldRunRetriever}，
 * 两套已经分叉且方向相反 —— 分歧清单与裁决记在 {@link AgentPlanDecision} 的类注释里。
 *
 * <p><b>次序也不再自己写</b>：{@code priority} / {@code parallelGroupId} / {@code dependsOn}
 * 三个字段全部由执行侧传进来的 {@link AgentStageExecutor#runOrder()} 派生。
 * 这里只决定<b>造哪些节点</b>，不决定它们谁先谁后 —— 那是 {@code AgentPosition} 的事。
 *
 * <h2>为什么要改</h2>
 *
 * <p>这三个字段此前都是手写的常量，而且都已经和执行对不上了：
 *
 * <ul>
 *   <li>{@code priority}：14 个节点里 <b>8 个</b>错位。{@code VERIFIER} 标 80（排在所有草稿之后），
 *       实际在 {@code PRE_STREAM#20}，比 {@code WIKI_TOOL_AGENT} 还早；
 *       {@code PLANNER/TASK_DRAFTER/WIKI_CURATOR} 标 30/31/32，实际在 {@code COMMIT}，是全场最后；
 *       {@code MEMORY_CURATOR/PLAN_EXTRACTOR/SUMMARIZER} 标 33/34/35，实际在 {@code POST_STREAM}，
 *       在最终回答<b>之后</b>。而 {@code listTasks} 正是 {@code orderByAsc(priority)} ——
 *       用户在执行轨迹里读到的次序就是这份错的。</li>
 *   <li>{@code parallelGroupId}：{@code RETRIEVER} 被标进 {@code "research"} 组，
 *       但 {@code RetrieverRunner} 没有并发组，它是合并点，从不与谁并发。</li>
 *   <li>{@code dependsOn}：全部是 {@code [orchestrator]} —— 星形，不含任何真实次序信息。</li>
 * </ul>
 *
 * <p>三者的共同点是<b>手写的次序声明会悄悄陈旧</b>：改一个 runner 的 {@code runAt} 不会有任何东西提醒
 * 这里也要改。派生之后它们不再是「与位置并列的第二个真相」，而是那个唯一真相的投影。
 */
@Service
public class MultiAgentOrchestratorImpl implements MultiAgentOrchestrator {
    private final AgentTaskGraphService taskGraphService;

    public MultiAgentOrchestratorImpl(AgentTaskGraphService taskGraphService) {
        this.taskGraphService = taskGraphService;
    }

    /** 一个待造的节点：只有「是什么」，没有「第几个」。 */
    private record NodeSpec(String agentType, String taskType, Map<String, Object> input, String summary) {
    }

    @Override
    public List<AiAgentTask> plan(AiAgentRun run, AgentPlanDecision decision, Long notebookId,
                                  List<AgentStageExecutor.RunSlot> runOrder) {
        List<NodeSpec> specs = new ArrayList<>();
        specs.add(new NodeSpec("ORCHESTRATOR", "PLAN_TASK_GRAPH",
                Map.of("agentMode", decision.mode()), "Plan task graph"));

        // NOTEBOOK 与 WIKI 合成一个节点：它们不是两个可独立调度的单元 ——
        // AiWorkspaceServiceImpl.sourceContext 一次 RAG 调用同时覆盖 Notebook 资料与 Wiki 页
        // （Wiki 在 SourceScopeResolver 返回的 ScopeSelection 里，带页数上界）。
        // 此前建图侧造两个节点，执行侧只有一次调用，于是图声称了一个执行里没有的结构 ——
        // 与幽灵/隐形 agent 同一个物种，只是方向是「多声称了一个」。
        //
        // 另一条路是把 RAG 调用拆成 notebook-only 与 wiki-only 两次以凑够两个单元，
        // 为了建模美观多花一次向量检索，不做。
        if (decision.needsNotebook() || (!"CHAT_ONLY".equals(decision.mode()) && decision.includeWiki())) {
            specs.add(new NodeSpec("CONTEXT_RESEARCHER", "RESEARCH_CONTEXT_SOURCES",
                    Map.of("notebookId", notebookId == null ? "" : notebookId), "Search Notebook and Wiki"));
        }
        if (decision.needsWeb()) {
            specs.add(new NodeSpec("WEB_RESEARCHER", "RESEARCH_WEB",
                    Map.of("allowWebSearch", true), "Search web sources"));
        }
        // 兜底 RETRIEVER：needsRetriever 为真但上面的专职 researcher 一个都没造出来时补一个。
        // 只勾了资料源（selectedSourceIds）而没开 Wiki / Notebook / 联网，走的正是这条 ——
        // 此前 needsRetriever 在建图侧漏掉了那一项，于是检索真的跑了、图里却没有节点（隐形 agent）。
        if (decision.needsRetriever() && specs.stream().noneMatch(item -> item.agentType().endsWith("_RESEARCHER"))) {
            specs.add(new NodeSpec("RETRIEVER", "RESEARCH_CONTEXT", Map.of(), "Search available context"));
        }
        if (decision.needsWikiTool()) {
            specs.add(new NodeSpec("WIKI_TOOL_AGENT", "WIKI_TOOL_LOOP", Map.of(), "Read and edit Wiki via tools"));
        }
        // 代码工作区。门在 AgentPlanDecision.needsCodeAgent 里，它已经把「工作区是否真的可读」
        // 算进去了 —— 工作区没开时这个节点根本不会被造出来，而不是造出来再跳过。
        if (decision.needsCodeAgent()) {
            specs.add(new NodeSpec("CODE_AGENT", "CODE_WORKSPACE_LOOP", Map.of(),
                    "Read and reason about code in the workspace"));
        }
        if (decision.needsPlanner()) {
            specs.add(new NodeSpec("PLANNER", "PLAN_DRAFT", Map.of(), "Draft plan"));
        }
        if (decision.needsTaskDraft()) {
            specs.add(new NodeSpec("TASK_DRAFTER", "TASK_DRAFT", Map.of(), "Draft tasks and routines"));
        }
        if (decision.needsWikiCurator()) {
            specs.add(new NodeSpec("WIKI_CURATOR", "WIKI_DRAFT", Map.of(), "Draft Wiki patch"));
        }
        if (decision.needsPlanExtractor()) {
            specs.add(new NodeSpec("PLAN_EXTRACTOR", "EXTRACT_PLAN", Map.of(), "Extract a structured plan draft"));
        }
        if (decision.needsMemoryDraft()) {
            specs.add(new NodeSpec("MEMORY_CURATOR", "MEMORY_DRAFT", Map.of(), "Draft long-term memory"));
        }
        specs.add(new NodeSpec("VERIFIER", "VERIFY_OUTPUT", Map.of(), "Verify claims and artifacts"));
        if (decision.needsSummary()) {
            specs.add(new NodeSpec("SUMMARIZER", "COMPRESS_HISTORY", Map.of(), "Compress older conversation turns"));
        }
        if (decision.needsAnswerVerifier()) {
            specs.add(new NodeSpec("ANSWER_VERIFIER", "VERIFY_ANSWER_CITATIONS", Map.of(),
                    "Check answer citations against evidence"));
        }
        specs.add(new NodeSpec("FINAL_WRITER", "FINAL_RESPONSE", Map.of(), "Generate final answer"));

        return materialize(run, specs, runOrder);
    }

    /**
     * 把「造哪些节点」按执行次序落成图。
     *
     * <p>{@code rank} 相同即并发（同一个 {@code parallelGroup}），它们彼此之间没有依赖、
     * 依赖同一批上游；{@code rank} 递增即顺序，每一层依赖<b>上一层</b>而不是依赖编排节点。
     */
    private List<AiAgentTask> materialize(AiAgentRun run, List<NodeSpec> specs,
                                          List<AgentStageExecutor.RunSlot> runOrder) {
        Map<String, AgentStageExecutor.RunSlot> slots = new HashMap<>();
        for (AgentStageExecutor.RunSlot slot : runOrder) {
            slots.put(slot.agentType(), slot);
        }
        for (NodeSpec spec : specs) {
            if (!slots.containsKey(spec.agentType())) {
                // 图里有、执行侧没有 —— 正是前几轮反复清掉的幽灵节点。
                // 派生次序让它变成启动期的硬失败，而不是一个永远 PENDING 的方块。
                throw new IllegalStateException(
                        "任务图声称了一个执行侧没有的 agent：" + spec.agentType()
                                + "。它不会被跑，只会在执行轨迹里留一个永远 PENDING 的节点。"
                                + "执行侧已知的有：" + slots.keySet());
            }
        }
        specs = new ArrayList<>(specs);
        specs.sort(Comparator.comparingInt(spec -> slots.get(spec.agentType()).rank()));
        // 下面用「第一个造出来的」当编排节点的父 id，那只在编排节点确实排第一时成立。
        // 今天成立（它在 PRE_STREAM#0），但那是巧合不是约束 —— 有人给某个 runner 一个负的
        // order，父子关系就会静默挂到别的节点上。宁可在这里说清楚。
        if (specs.isEmpty() || !"ORCHESTRATOR".equals(specs.get(0).agentType())) {
            throw new IllegalStateException(
                    "编排节点必须排在最前（它是所有节点的父）。实际排第一的是："
                            + (specs.isEmpty() ? "（空图）" : specs.get(0).agentType())
                            + "。多半是有 runner 的 runAt 排到了 ORCHESTRATOR 之前");
        }

        List<AiAgentTask> tasks = new ArrayList<>();
        Long orchestratorId = null;
        int currentRank = Integer.MIN_VALUE;
        List<Long> upstream = List.of();
        List<Long> currentLevel = new ArrayList<>();
        for (NodeSpec spec : specs) {
            AgentStageExecutor.RunSlot slot = slots.get(spec.agentType());
            if (slot.rank() != currentRank) {
                if (!currentLevel.isEmpty()) {
                    upstream = List.copyOf(currentLevel);
                    currentLevel.clear();
                }
                currentRank = slot.rank();
            }
            AiAgentTask created = taskGraphService.createTask(run.getId(), orchestratorId,
                    spec.agentType(), spec.taskType(), slot.rank(), slot.parallelGroup(),
                    upstream, spec.input(), spec.summary());
            if (orchestratorId == null) {
                orchestratorId = created.getId();
            }
            currentLevel.add(created.getId());
            tasks.add(created);
        }
        return tasks;
    }
}
