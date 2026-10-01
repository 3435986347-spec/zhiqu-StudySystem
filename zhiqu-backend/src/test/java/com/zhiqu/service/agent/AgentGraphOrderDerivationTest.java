package com.zhiqu.service.agent;

import com.zhiqu.entity.AiAgentRun;
import com.zhiqu.entity.AiAgentTask;
import com.zhiqu.service.AgentTaskGraphService;
import com.zhiqu.service.impl.MultiAgentOrchestratorImpl;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 任务图的 {@code priority} / {@code parallelGroupId} / {@code dependsOn} 必须由真实执行位置派生。
 *
 * <h2>这三个字段此前都是手写的，而且都已经陈旧</h2>
 *
 * <p>最要命的是 {@code priority}：{@code AgentTaskGraphServiceImpl.listTasks} 是
 * {@code orderByAsc(priority)}，所以它<b>就是用户在执行轨迹里读到的次序</b>，不是内部元数据。
 * 而 14 个节点里 8 个错位 —— {@code VERIFIER} 标 80 实际在 {@code PRE_STREAM#20}，
 * {@code PLANNER/TASK_DRAFTER/WIKI_CURATOR} 标 30/31/32 实际在 {@code COMMIT}（全场最后），
 * {@code MEMORY_CURATOR/PLAN_EXTRACTOR/SUMMARIZER} 标 33/34/35 实际在最终回答<b>之后</b>。
 * 用户看到的顺序和真实发生的顺序，有一大半对不上。
 *
 * <h2>判据不自带一份次序</h2>
 *
 * <p>期望值来自 {@link RealRunOrder}，它解析 {@code AiServiceImpl} 里真实声明的
 * {@code runAt()}，再交给真的 {@link AgentStageExecutor#runOrder()} 排名。
 * 在这里手抄一串数字，就是把刚消灭的「第二个真相」原样搬进测试 ——
 * 那样改一个 runner 的位置，判据会红在自己那份过期的期望上。
 *
 * <h2>扰动</h2>
 *
 * <ul>
 *   <li>把 {@code materialize} 里的 {@code slot.rank()} 换回手写数字 → 第一条红</li>
 *   <li>{@code dependsOn} 换回 {@code List.of(orchestratorId)} → 第二、三条红</li>
 *   <li>{@code slot.parallelGroup()} 换回字面量 {@code "research"} → 第四条红</li>
 *   <li>去掉幽灵节点检查 → 第五条红</li>
 * </ul>
 */
class AgentGraphOrderDerivationTest {

    /** 造一份「什么都要」的判定，好让图上尽可能多的节点都出现。 */
    private static AgentPlanDecision everything() {
        return new AgentPlanDecision("RESEARCH",
                true,   // needsRetriever
                true,   // needsNotebook
                true,   // needsWeb
                true,   // includeWiki
                true,   // needsPlanner
                true,   // needsTaskDraft
                true,   // needsWikiCurator
                true,   // needsMemoryDraft
                true,   // needsPlanExtractor
                true,   // needsWikiTool
                true,   // needsCodeAgent
                true,   // needsAnswerVerifier
                true);  // needsSummary
    }

    private static List<AiAgentTask> plan(AgentPlanDecision decision, RecordingGraph graph) {
        AiAgentRun run = new AiAgentRun();
        run.setId(1L);
        return new MultiAgentOrchestratorImpl(graph).plan(run, decision, 7L, RealRunOrder.slots());
    }

    /**
     * 图的次序必须等于执行的次序。
     *
     * <p>这里不比数字本身，比<b>节点的先后</b>：期望序列由真实位置算出来，
     * 于是「派生」这件事本身被钉住，而不是钉住某一串具体的 priority 值。
     */
    @Test
    void 图的次序必须等于真实执行次序() {
        RecordingGraph graph = new RecordingGraph();
        List<AiAgentTask> tasks = plan(everything(), graph);

        assertTrue(tasks.size() >= 12,
                "下界：这份判定该造出十几个节点。只造出 " + tasks.size()
                        + " 个的话，下面每条断言都可能是空过的");

        Map<String, Integer> rank = new LinkedHashMap<>();
        for (AgentStageExecutor.RunSlot slot : RealRunOrder.slots()) {
            rank.put(slot.agentType(), slot.rank());
        }
        List<String> actual = tasks.stream().map(AiAgentTask::getAgentType).toList();
        List<String> expected = new ArrayList<>(actual);
        expected.sort(Comparator.comparingInt(rank::get));
        assertEquals(expected, actual,
                "建图的顺序必须就是执行的顺序 —— listTasks 按 priority 排序，这串顺序就是"
                        + "用户在执行轨迹里读到的东西");

        List<Integer> priorities = tasks.stream().map(AiAgentTask::getPriority).toList();
        assertEquals(priorities.stream().sorted().toList(), priorities,
                "priority 必须随执行次序单调不减，实际：" + priorities);

        // 上面那条是「自洽」判据：把 priority 全写成 0 它也绿（排序稳定）。
        // 所以这里再钉三处旧数字弄反了的具体关系 —— 它们是这次改动买到的东西。
        assertTrue(indexOf(actual, "VERIFIER") < indexOf(actual, "WIKI_TOOL_AGENT"),
                "VERIFIER 在 PRE_STREAM#20，比 WIKI_TOOL_AGENT(#40) 早；旧数字 80 vs 20 把它排反了");
        assertTrue(indexOf(actual, "FINAL_WRITER") < indexOf(actual, "SUMMARIZER"),
                "摘要器在 POST_STREAM，发生在最终回答之后；旧数字 35 vs 90 把它排在回答前面");
        assertTrue(indexOf(actual, "FINAL_WRITER") < indexOf(actual, "PLANNER"),
                "PLANNER 在 COMMIT，是全场最后几个之一；旧数字 30 vs 90 把它排在回答前面");
    }

    private static int indexOf(List<String> types, String type) {
        int at = types.indexOf(type);
        assertTrue(at >= 0, "这份判定本该造出 " + type + " 节点，实际：" + types);
        return at;
    }

    /**
     * {@code dependsOn} 必须指向<b>上一层</b>，而不是一律指向编排节点。
     *
     * <p>星形不含任何次序信息：它对所有图都成立，所以它什么也没说。
     */
    @Test
    void 依赖必须指向上一层而不是星形() {
        RecordingGraph graph = new RecordingGraph();
        List<AiAgentTask> tasks = plan(everything(), graph);
        Long orchestratorId = tasks.get(0).getId();
        assertEquals("ORCHESTRATOR", tasks.get(0).getAgentType(), "编排节点必须最先造，它是所有节点的父");
        assertEquals(List.of(), graph.dependsOn(orchestratorId), "编排节点本身不依赖任何人");

        long starShaped = tasks.stream()
                .filter(task -> !task.getId().equals(orchestratorId))
                .filter(task -> List.of(orchestratorId).equals(graph.dependsOn(task.getId())))
                .count();
        assertTrue(starShaped <= 2,
                "只有紧跟编排节点的第一层才该依赖它；实际有 " + starShaped + " 个节点直接挂在编排节点上 —— "
                        + "那是星形，不含真实次序");

        Long finalWriterId = idOf(tasks, "FINAL_WRITER");
        assertNotEquals(List.of(orchestratorId), graph.dependsOn(finalWriterId),
                "最终回答依赖它前面那一层（校验 / Wiki 工具），不是依赖编排节点");
        assertFalse(graph.dependsOn(finalWriterId).isEmpty(), "它前面明明有节点，依赖不该是空的");

        // 上面几条的下界：每个非编排节点都必须有上游，否则「依赖全清空」也能让它们绿
        for (AiAgentTask task : tasks) {
            if (task.getId().equals(orchestratorId)) {
                continue;
            }
            assertFalse(graph.dependsOn(task.getId()).isEmpty(),
                    task.getAgentType() + " 没有任何上游 —— 图会散成孤立的点");
        }
    }

    @Test
    void 同组成员之间不得互相依赖() {
        RecordingGraph graph = new RecordingGraph();
        List<AiAgentTask> tasks = plan(everything(), graph);
        Long contextId = idOf(tasks, "CONTEXT_RESEARCHER");
        Long webId = idOf(tasks, "WEB_RESEARCHER");

        assertEquals(graph.priority(contextId), graph.priority(webId),
                "两路检索并发，次序上是同一层");
        assertEquals(graph.dependsOn(contextId), graph.dependsOn(webId),
                "同一层依赖同一批上游");
        assertFalse(graph.dependsOn(webId).contains(contextId),
                "并发的两个之间不得有依赖边 —— 有了就等于声称它们是顺序的");
        assertFalse(graph.dependsOn(contextId).contains(webId), "反向同理");

        // POST_STREAM 那三个同理（它们同组）
        Long memoryId = idOf(tasks, "MEMORY_CURATOR");
        Long extractId = idOf(tasks, "PLAN_EXTRACTOR");
        Long summaryId = idOf(tasks, "SUMMARIZER");
        assertEquals(graph.priority(memoryId), graph.priority(extractId));
        assertEquals(graph.priority(memoryId), graph.priority(summaryId),
                "记忆草稿 / 计划提取 / 滚动摘要在同一个 POST_STREAM 并发组里，图上也该是同一层");
    }

    /**
     * 并发组标注必须来自执行侧。
     *
     * <p>{@code RETRIEVER} 此前被手写成 {@code "research"} 组，而 {@code RetrieverRunner}
     * 根本没有并发组 —— 它是两路检索的合并点，从不与谁并发。图声称了一个不存在的并发。
     */
    @Test
    void 并发组标注必须来自执行侧() {
        RecordingGraph graph = new RecordingGraph();
        List<AiAgentTask> tasks = plan(everything(), graph);
        assertEquals("research", graph.group(idOf(tasks, "CONTEXT_RESEARCHER")));
        assertEquals("research", graph.group(idOf(tasks, "WEB_RESEARCHER")));
        assertEquals("post-stream", graph.group(idOf(tasks, "SUMMARIZER")),
                "摘要器进了 POST_STREAM 并发组，图上也该标出来");
        assertNull(graph.group(idOf(tasks, "VERIFIER")), "校验不与谁并发");

        // 兜底 RETRIEVER：只勾资料源时才出现，所以要单独造一份判定
        RecordingGraph fallback = new RecordingGraph();
        List<AiAgentTask> only = plan(new AgentPlanDecision("AUTO",
                true, false, false, false, false, false, false, false, false,
                false,   // needsWikiTool
                false,   // needsCodeAgent
                true, false), fallback);
        assertNull(fallback.group(idOf(only, "RETRIEVER")),
                "RetrieverRunner 没有并发组 —— 它是合并点。手写的 \"research\" 声称了一个不存在的并发");
    }

    /**
     * 图里出现执行侧没有的 agent，必须当场报错。
     *
     * <p>这是前几轮反复清掉的幽灵节点。派生次序把它变成建图期的硬失败，
     * 而不是执行轨迹里一个永远 PENDING 的方块。
     */
    @Test
    void 执行侧没有的节点必须当场报错() {
        List<AgentStageExecutor.RunSlot> incomplete = RealRunOrder.slots().stream()
                .filter(slot -> !"SUMMARIZER".equals(slot.agentType()))
                .toList();
        AiAgentRun run = new AiAgentRun();
        run.setId(1L);
        MultiAgentOrchestratorImpl orchestrator = new MultiAgentOrchestratorImpl(new RecordingGraph());

        IllegalStateException thrown = assertThrows(IllegalStateException.class,
                () -> orchestrator.plan(run, everything(), 7L, incomplete),
                "图声称了一个执行侧没有的 agent，必须当场炸 —— 否则它只会是个永远 PENDING 的节点");
        assertTrue(thrown.getMessage().contains("SUMMARIZER"),
                "报错要点名是哪个，实际：" + thrown.getMessage());

        // 反例：完整的名单不得报错。没有它，「一律抛」也能让上面绿
        List<AiAgentTask> complete = new MultiAgentOrchestratorImpl(new RecordingGraph())
                .plan(run, everything(), 7L, RealRunOrder.slots());
        assertTrue(complete.size() >= 12,
                "名单完整时必须正常建图，实际只造出 " + complete.size() + " 个节点");
    }

    private static Long idOf(List<AiAgentTask> tasks, String agentType) {
        return tasks.stream().filter(task -> agentType.equals(task.getAgentType()))
                .map(AiAgentTask::getId).findFirst()
                .orElseThrow(() -> new AssertionError("这份判定本该造出 " + agentType + " 节点"));
    }

    /** 记录 priority / parallelGroupId / dependsOn 的桩 —— 建图逻辑不落库。 */
    private static final class RecordingGraph implements AgentTaskGraphService {
        private final Map<Long, Integer> priorities = new LinkedHashMap<>();
        private final Map<Long, String> groups = new LinkedHashMap<>();
        private final Map<Long, List<Long>> dependencies = new LinkedHashMap<>();
        private long nextId = 1L;

        int priority(Long id) { return priorities.get(id); }
        String group(Long id) { return groups.get(id); }
        List<Long> dependsOn(Long id) { return dependencies.get(id); }

        @Override
        public AiAgentTask createTask(Long runId, Long parentTaskId, String agentType, String taskType,
                                      int priority, String parallelGroupId, List<Long> dependsOn,
                                      Map<String, Object> input, String publicSummary) {
            AiAgentTask task = new AiAgentTask();
            task.setId(nextId++);
            task.setRunId(runId);
            task.setAgentType(agentType);
            task.setTaskType(taskType);
            task.setPriority(priority);
            priorities.put(task.getId(), priority);
            groups.put(task.getId(), parallelGroupId);
            dependencies.put(task.getId(), List.copyOf(dependsOn));
            return task;
        }

        @Override public AiAgentTask startTask(AiAgentTask task) { return task; }
        @Override public void completeTask(AiAgentTask task, Map<String, Object> output, String publicSummary) { }
        @Override public AiAgentTask skipTask(Long runId, String agentType, String taskType, String publicSummary) { return null; }
        @Override public void skipTask(AiAgentTask task, String publicSummary) { }
        @Override public void errorTask(AiAgentTask task, Exception error) { }
        @Override public List<AiAgentTask> listTasks(Long runId) { return List.of(); }
        @Override public List<Map<String, Object>> listTaskRows(Long runId) { return List.of(); }
    }

    /**
     * 真实那批 runner 必须能构造出一个执行器 —— 不许有两个抢同一个槽位。
     *
     * <h2>这条判据是被一次 384 秒的挂起逼出来的</h2>
     *
     * <p>{@code AgentStageExecutor} 的构造函数里有 {@code rejectAmbiguousSlots}，
     * 注释写着「宁可启动就炸」。它确实会抛 —— 但执行器是<b>每次流式请求</b>在异步线程上
     * 构造的，抛出去被 {@code CompletableFuture} 静默吞掉。于是：
     *
     * <ul>
     *   <li>run 停在 RUNNING，永远不结束</li>
     *   <li>模型一次都没被调用</li>
     *   <li>日志里一行异常都没有</li>
     * </ul>
     *
     * <p>2026-09-21 新加 {@code CODE_AGENT} 时把 {@code runAt} 放在 PRE_STREAM#45，
     * 而 {@code PLAN_EXTRACTOR} 的 {@code announceAt} 已经在那儿（{@code announceAt} 与
     * {@code commitAt} 不覆写就等于 {@code runAt}，所以一个 runner 默认占三个动作槽）。
     * 表现是 15 条集成判据一起红、跑一次 384 秒、没有任何错误信息 ——
     * 一个「启动期硬失败」的守卫，实际上只会让人看到挂起。
     *
     * <p>把它提到编译期这一侧：这条判据 1 秒就给出答案，并且直接点名是哪两个 runner。
     *
     * <p>注意它依赖 {@link RealRunOrder} 读全 {@code runAt}/{@code announceAt}/{@code commitAt}
     * 三个位置。原来只读 {@code runAt}，所以这个冲突在判据眼里根本不存在。
     *
     * <p>扰动：把任意一个 runner 的 {@code runAt} 改到另一个已被占用的位置 → 本条红。
     */
    @Test
    void 真实runner之间不得抢同一个槽位() {
        List<RealRunOrder.Declared> declared = RealRunOrder.declarations();

        // 下限：解析空了的话，「没有冲突」和「什么都没看到」形状一样。
        assertTrue(declared.size() >= 14,
                "只解析出 " + declared.size() + " 个 runner —— 解析坏了，这条判据什么都没看到");

        // 先自己摊开「谁占了哪三个槽」再去构造执行器 —— 顺序是有意的。
        // 反过来的话，执行器的守卫会先抛，红出来是一条 ERROR（异常），
        // 而不是一条带着「哪两个 runner、哪个槽」的 FAILURE。同样是红，可读性差一截。
        Map<String, String> claimed = new LinkedHashMap<>();
        List<String> collisions = new ArrayList<>();
        for (RealRunOrder.Declared item : declared) {
            AgentPosition run = AgentPosition.at(item.phase(), item.order());
            record Slot(String moment, AgentPosition at) { }
            for (Slot slot : List.of(
                    new Slot("ANNOUNCE", item.announce() != null ? item.announce() : run),
                    new Slot("RUN", run),
                    new Slot("COMMIT", item.commit() != null ? item.commit() : run))) {
                String key = slot.at() + "/" + slot.moment();
                String previous = claimed.putIfAbsent(key, item.agentType());
                if (previous != null && !previous.equals(item.agentType())) {
                    collisions.add(key + " 被 " + previous + " 和 " + item.agentType() + " 同时占用");
                }
            }
        }
        assertEquals(List.of(), collisions,
                "两个 runner 抢同一个 (位置, 动作) 槽。注意 announceAt/commitAt 不覆写时等于 runAt —— "
                        + "一个 runner 默认占三个槽，挑新位置时要把这三个都算上。"
                        + "线上的后果是整轮静默挂起：异常在流式的异步线程上抛，没人接");

        // 兜底：真执行器的 rejectAmbiguousSlots 是生产代码里的那一份判定。
        // 上面那段是它的复述，复述可能和它分叉 —— 所以最后还是要让真的那份跑一遍。
        List<AgentStageExecutor.RunSlot> slots = RealRunOrder.slots();
        assertEquals(declared.size(), slots.size(),
                "每个 runner 都该在 runOrder() 里出现一次");
    }
}
