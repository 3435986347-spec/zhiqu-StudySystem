package com.zhiqu.service.agent;

import com.zhiqu.SourceText;
import com.zhiqu.entity.AiAgentRun;
import com.zhiqu.entity.AiAgentTask;
import com.zhiqu.service.AgentTaskGraphService;
import com.zhiqu.service.ContextOptionKeys;
import com.zhiqu.service.impl.MultiAgentOrchestratorImpl;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 意图判定必须只有一处，且「造了节点」与「跑了节点」出自同一个判定。
 *
 * <h2>三条判据各买不同的东西，别当成互相冗余</h2>
 *
 * <table border="1">
 *   <caption>各自买到什么</caption>
 *   <tr><th>判据</th><th>买到什么</th><th>扰动见红</th></tr>
 *   <tr><td>{@link #意图判定只能有一处()}</td>
 *       <td>防「同一事实两份拷贝」重新长出来</td>
 *       <td>把任一旧方法名加回任一实现</td></tr>
 *   <tr><td>{@link #执行侧不得按判定分项自己决定跑不跑()}</td>
 *       <td>防执行侧重新长出一套独立计算 —— 上一次分叉就是这么来的</td>
 *       <td>把任何一处执行判断改回 {@code decision.needsPlanner()}</td></tr>
 *   <tr><td>{@link #判定词表_两处历史分叉都必须被合并覆盖()}</td>
 *       <td><b>本轮两个缺陷的唯一防护</b></td>
 *       <td>从词表里删「安排」，或把 selectedSourceIds 从 needsRetriever 拿掉</td></tr>
 *   <tr><td>{@link #建图按判定造节点()}</td>
 *       <td>钉「判定为真 ⟺ 节点被造出来」这一半（另一半由第 2 条钉）</td>
 *       <td>把 orchestrator 里任一 {@code if (decision.…)} 改成常量</td></tr>
 * </table>
 *
 * <h2>合并前的两处历史分叉（方向相反）</h2>
 *
 * <p>建图侧的词表含「安排」而执行侧不含 → <b>幽灵 agent</b>：造出 PLANNER 节点后立刻被 skip。<br>
 * 执行侧的 needsRetriever 含 {@code selectedSourceIds} 而建图侧不含 → <b>隐形 agent</b>：
 * 检索真的跑了、图里却没有 RETRIEVER 节点。
 *
 * <p>所以合并<b>必须逐个关键词裁决</b>，整体择一必然错一半 ——
 * 这正是第 3 条判据要钉死的两件事。
 */
class AgentPlanDecisionWiringTest {

    private static final Path AI_SERVICE =
            Path.of("src", "main", "java", "com", "zhiqu", "service", "impl", "AiServiceImpl.java");
    private static final Path ORCHESTRATOR =
            Path.of("src", "main", "java", "com", "zhiqu", "service", "impl", "MultiAgentOrchestratorImpl.java");

    /** 合并前散在两处的判定方法名。任何一个重新出现，都意味着第二份拷贝回来了。 */
    private static final List<String> RETIRED_DECIDERS = List.of(
            "shouldRunRetriever", "shouldRunPlanner", "shouldPlan", "shouldDraftTasks", "shouldCurateWiki");

    @Test
    void 意图判定只能有一处() throws IOException {
        // 必须剥注释再查：本类与 orchestrator 的注释里都写着这些旧名字（记录它们为什么被合并），
        // 不剥的话这条判据会被那些说明文字满足 —— 本仓库已两次栽在这上面。
        String service = SourceText.stripComments(Files.readString(AI_SERVICE, StandardCharsets.UTF_8));
        String orchestrator = SourceText.stripComments(Files.readString(ORCHESTRATOR, StandardCharsets.UTF_8));

        List<String> revived = new ArrayList<>();
        for (String name : RETIRED_DECIDERS) {
            if (service.contains(name) || orchestrator.contains(name)) revived.add(name);
        }
        assertTrue(revived.isEmpty(),
                "以下判定方法重新出现在实现里：" + revived
                        + "。意图判定必须只在 AgentPlanDecision 一处 —— 两侧各算一套正是上一次分叉的成因"
                        + "（建图侧含「安排」而执行侧不含；执行侧含 selectedSourceIds 而建图侧不含）");
    }

    /**
     * 这条判据换过一次方向，值得记一笔：图驱动之前它要求的是<b>相反</b>的东西 ——
     * 「执行侧必须出现 {@code decision.needsPlanner()}」。那时执行是一条硬编码流水线，
     * 「两侧读同一个对象」是当时能拿到的最强保证。图驱动之后，执行侧改成读图，
     * 而图本身就是从 decision 建出来的，于是「读图」比「读同一个对象」更强：
     * 判定 → 建图 → 执行成了一条链，中间不再有第二条通路。判据跟着换成更强的那一个，
     * 旧措辞被这次改造合法地红掉，不是回归。
     */
    @Test
    void 执行侧不得按判定分项自己决定跑不跑() throws IOException {
        String service = SourceText.stripComments(Files.readString(AI_SERVICE, StandardCharsets.UTF_8));

        assertFalse(service.contains("decision.needs"),
                "AiServiceImpl 里出现了 decision.needsXxx()：执行侧又在按判定分项决定跑不跑。"
                        + "跑不跑必须只由图决定（节点在不在图里），否则建图与执行又是两条独立通路，"
                        + "而分叉不会当天暴露 —— 上一次是等到有人只说「安排」时才显形");

        // 下界：确认 decision 还真的在喂建图。少了这句，把 decision 整个删掉也能让上面那条通过。
        assertTrue(service.contains("multiAgentOrchestrator.plan(agentRun, decision"),
                "判定必须仍然是建图的输入，否则上面那条是在「根本没有 decision」上假绿的");
    }

    @Test
    void 判定词表_两处历史分叉都必须被合并覆盖() {
        // ① 只含「安排」：不含 计划/任务/例行/plan。合并前建图侧为真、执行侧为假 → 幽灵 agent。
        AgentPlanDecision arrange = AgentPlanDecision.of("AUTO", "帮我安排下周的复习", false, null, Map.of());
        assertTrue(arrange.needsPlanner(),
                "「安排」必须触发 planner：合并前建图侧有它、执行侧没有，造出的节点会立刻被 skip");

        // ② 只带 selectedSourceIds：不带 includeWiki、无 notebook、不联网。
        //    合并前执行侧为真、建图侧为假 → 隐形 agent。
        AgentPlanDecision sources = AgentPlanDecision.of(
                "AUTO", "这份资料讲了什么", false, null,
                Map.of(ContextOptionKeys.SELECTED_SOURCE_IDS, List.of(1L, 2L)));
        assertTrue(sources.needsRetriever(),
                "选中资料源必须触发检索：合并前执行侧有它、建图侧没有，检索会跑但图里没有 RETRIEVER 节点");

        // 反向：什么都没有时两者都不该为真，否则上面两条会在「恒为真」上假绿。
        AgentPlanDecision bare = AgentPlanDecision.of("AUTO", "你好", false, null, Map.of());
        assertFalse(bare.needsPlanner(), "无触发词时不应跑 planner —— 否则 ① 是在恒真上通过的");
        assertFalse(bare.needsRetriever(), "无任何来源时不应检索 —— 否则 ② 是在恒真上通过的");

        // CHAT_ONLY 必须压过一切来源
        AgentPlanDecision chatOnly = AgentPlanDecision.of(
                "CHAT_ONLY", "帮我安排下周的复习", true, 7L,
                Map.of(ContextOptionKeys.SELECTED_SOURCE_IDS, List.of(1L)));
        assertFalse(chatOnly.needsRetriever(), "CHAT_ONLY 不检索");
        assertFalse(chatOnly.needsPlanner(), "CHAT_ONLY 不跑 planner");
    }

    @Test
    void 建图按判定造节点() {
        RecordingTaskGraph graph = new RecordingTaskGraph();
        MultiAgentOrchestratorImpl orchestrator = new MultiAgentOrchestratorImpl(graph);
        AiAgentRun run = new AiAgentRun();
        run.setId(1L);

        // 只带 selectedSourceIds —— 合并前这里造不出任何 researcher（隐形 agent）
        orchestrator.plan(run, AgentPlanDecision.of("AUTO", "这份资料讲了什么", false, null,
                Map.of(ContextOptionKeys.SELECTED_SOURCE_IDS, List.of(1L))), null);
        assertTrue(graph.types().contains("RETRIEVER"),
                "只勾资料源时必须造出 RETRIEVER 节点，否则用户在执行轨迹里看不到这次检索。实际：" + graph.types());

        graph.reset();
        // 只含「安排」—— 合并前造了 PLANNER 但执行侧不跑（幽灵 agent）
        orchestrator.plan(run, AgentPlanDecision.of("AUTO", "帮我安排下周的复习", false, null, Map.of()), null);
        assertTrue(graph.types().contains("PLANNER"), "「安排」必须造出 PLANNER 节点。实际：" + graph.types());

        graph.reset();
        orchestrator.plan(run, AgentPlanDecision.of("CHAT_ONLY", "帮我安排下周的复习", true, 7L, Map.of()), 7L);
        assertEquals(Set.of("ORCHESTRATOR", "VERIFIER", "FINAL_WRITER"), graph.types(),
                "CHAT_ONLY 只该留下编排、校验与最终回答三个节点");
    }

    /** 只记录被造出来的节点类型的桩 —— 建图逻辑不落库，不需要 Spring 上下文。 */
    private static final class RecordingTaskGraph implements AgentTaskGraphService {
        private final List<AiAgentTask> created = new ArrayList<>();
        private long nextId = 1L;

        Set<String> types() {
            return created.stream().map(AiAgentTask::getAgentType).collect(Collectors.toSet());
        }

        void reset() {
            created.clear();
        }

        @Override
        public AiAgentTask createTask(Long runId, Long parentTaskId, String agentType, String taskType,
                                      int priority, String parallelGroupId, List<Long> dependsOn,
                                      Map<String, Object> input, String publicSummary) {
            AiAgentTask task = new AiAgentTask();
            task.setId(nextId++);
            task.setRunId(runId);
            task.setAgentType(agentType);
            task.setTaskType(taskType);
            created.add(task);
            return task;
        }

        @Override public AiAgentTask startTask(AiAgentTask task) { return task; }
        @Override public void completeTask(AiAgentTask task, Map<String, Object> output, String publicSummary) { }
        @Override public AiAgentTask skipTask(Long runId, String agentType, String taskType, String publicSummary) { return null; }
        @Override public void skipTask(AiAgentTask task, String publicSummary) { }
        @Override public void errorTask(AiAgentTask task, Exception error) { }
        @Override public List<AiAgentTask> listTasks(Long runId) { return List.copyOf(created); }
        @Override public List<Map<String, Object>> listTaskRows(Long runId) { return List.of(); }
    }
}
