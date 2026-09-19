package com.zhiqu.service.agent;

import com.zhiqu.service.ContextOptionKeys;

import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 一轮问答的意图判定 —— <b>唯一定义</b>。建图与执行都读它。
 *
 * <h2>为什么需要它：同一件事此前写在两处，而且已经分叉了</h2>
 *
 * <p>「这轮要不要跑 planner / retriever」此前有两套实现：
 * {@code MultiAgentOrchestratorImpl} 用一套决定<b>造哪些任务节点</b>，
 * {@code AiServiceImpl} 用另一套决定<b>跑不跑</b>。两套已经不一致，
 * 而且<b>方向相反</b>——这正是「同一事实两份拷贝」积累久了的样子，它不会只朝一个方向漂：
 *
 * <table border="1">
 *   <caption>合并前的两处分歧与裁决</caption>
 *   <tr><th>分歧点</th><th>建图侧</th><th>执行侧</th><th>裁决</th><th>症状</th></tr>
 *   <tr><td>{@code 安排}（planner 触发词）</td><td>有</td><td><b>无</b></td>
 *       <td><b>保留</b>（以建图侧为准）</td>
 *       <td><b>幽灵 agent</b>：造出 PLANNER 节点 → 执行侧判 false → 立刻 skip，
 *           用户看到一个宣告出现又立即消失的 agent</td></tr>
 *   <tr><td>{@link ContextOptionKeys#SELECTED_SOURCE_IDS}（retriever 触发）</td>
 *       <td><b>无</b></td><td>有</td><td><b>保留</b>（以执行侧为准）</td>
 *       <td><b>隐形 agent</b>：检索真的跑了，图里却没有 RETRIEVER 节点，
 *           用户在执行轨迹里看不到这次检索</td></tr>
 * </table>
 *
 * <p><b>合并必须逐个关键词裁决，不能整体择一。</b>整体择一必然错一半：
 * 以建图侧为准会删掉 {@code SELECTED_SOURCE_IDS} 那一条（用户选了资料源却不再检索，
 * 是功能回退）；以执行侧为准会丢掉「安排」。
 *
 * <p>两条裁决的性质不同，别笼统记成「一次行为变化」：
 * 「安排」是<b>新增行为</b>（此前造了节点不跑），{@code SELECTED_SOURCE_IDS} 是<b>保留行为</b>
 * （此前跑了不造节点，本次补上节点，执行侧一如既往）。
 *
 * <p>隐形 agent 那条今天被前端掩着：活壳恒发 {@code includeWiki: true}
 * （见 {@link ContextOptionKeys#INCLUDE_WIKI}），于是两侧都为真、撞不到分歧。
 * <b>走 UI 撞不到，直接调 API 撞得到。</b>
 */
public record AgentPlanDecision(
        String mode,
        boolean needsRetriever,
        boolean needsNotebook,
        boolean needsWeb,
        boolean includeWiki,
        boolean needsPlanner,
        boolean needsTaskDraft,
        boolean needsWikiCurator,
        boolean needsMemoryDraft,
        boolean needsPlanExtractor,
        boolean needsWikiTool
) {

    private static final Set<String> MODES = Set.of("AUTO", "CHAT_ONLY", "RESEARCH", "PLAN");

    /**
     * 合并后的 planner 触发词。<b>「安排」在内</b> —— 建图侧此前有、执行侧此前没有，裁决为保留。
     * 与 {@code looksTaskCreationIntent} 是两件事：那个决定「是否调 create_study_plan 工具」，
     * 这个决定「造不造 PLANNER 节点、跑不跑」，合并需单独论证，本轮不动。
     */
    private static final List<String> PLANNER_WORDS = List.of("计划", "安排", "任务", "例行", "plan");
    private static final List<String> TASK_DRAFT_WORDS = List.of("生成任务", "写入任务", "例行任务", "task");
    /**
     * WIKI_CURATOR 的门 —— <b>两张表 AND，必须同时提到 Wiki 和写动词</b>。
     *
     * <h2>此前建图与执行是两个形状不同的门，两个方向都漏</h2>
     *
     * <p>建图侧曾是平表 OR（{@code wiki | 知识库 | 知识 wiki | 写进知识}），执行侧是这里的 AND。
     * OR 比 AND 松，于是：
     *
     * <ul>
     *   <li><b>有节点、跑不了（常见）</b>：「知识库里有什么」—— 最普通的 wiki 读问题 ——
     *       命中 OR 的「知识库」却没有写动词，<b>每一次这样的提问</b>都造出一个结构上不可能
     *       运行的节点，然后被 settleUnrunTasks 扫掉，和一次正当的无事可做完全同形。</li>
     *   <li><b>没节点、却产出（偶发）</b>：「把这个存入我的笔记」命中 AND（笔记 + 存入），
     *       不命中 OR（无 wiki/知识库）—— 工件产出了、图里没有节点，隐形 agent。</li>
     * </ul>
     *
     * <p>两个方向同源：<b>形状不同</b>，不是词表不同。统一成 AND 之后两边读同一个门，
     * runner 不再需要 {@code inGraph} 恒真的后门。
     *
     * <p>词表与 {@code looksWikiToolIntent} 保持对应：写动词是它 readOrWrite 里「写类」动词的子集，
     * 保证「写意图 ⟹ 工具意图且下发写工具」—— 否则会启动 Agent 却不给它写工具。
     */
    private static final List<String> WIKI_MENTION_WORDS =
            List.of("wiki", "知识库", "知识页", "知识树", "笔记", "我记");
    private static final List<String> WIKI_WRITE_WORDS = List.of(
            "写进", "写入", "写到", "存入", "存到", "存进", "保存", "收录", "放进", "放到",
            "加入", "整理到", "同步到", "记到", "记进", "记录", "更新", "补充", "新建");
    /**
     * 长期记忆草稿的触发词，从 {@code AiServiceImpl.looksMemoryWorthy} 搬过来 —— 那是第六个
     * 散在实现里的意图门，和合并前的 {@code should*} 家族同一个物种：建图侧要用它决定造不造
     * MEMORY_CURATOR 节点，执行侧要用它决定跑不跑，两边各算一套就会重演幽灵/隐形 agent。
     */
    private static final List<String> MEMORY_DRAFT_WORDS = List.of(
            "记住", "我的目标", "我希望", "我不喜欢", "我准备", "我打算", "我计划",
            "考研", "薄弱", "偏好", "ddl");

    public static String normalizeMode(String agentMode) {
        String value = agentMode == null ? "AUTO" : agentMode.trim().toUpperCase(Locale.ROOT);
        return MODES.contains(value) ? value : "AUTO";
    }

    /**
     * 计划提取的门 —— 从 {@code AiServiceImpl.looksTaskCreationIntent} 搬来。
     *
     * <p>它与 {@link #PLANNER_WORDS} <b>是两件事</b>，别合并：这个决定「是否调 create_study_plan
     * 工具把计划提取成草稿」，那个决定「造不造 PLANNER 节点」。「帮我安排下周的复习」命中后者、
     * 不命中前者 —— 要计划节奏，但没让系统建任务。合并需单独论证。
     */
    private static final List<String> TASK_CREATE_PLAN_WORDS =
            List.of("计划", "规划", "安排", "拆", "任务", "ddl", "deadline");
    private static final List<String> TASK_CREATE_VERB_WORDS =
            List.of("生成", "写到", "写入", "加入", "添加", "创建", "放到", "导入", "过目");

    /**
     * Wiki 工具循环的门 —— 从 {@code AiServiceImpl.looksWikiToolIntent} 搬来。
     *
     * <p>读或写都算：这个 agent 既做 search/read（结果进回答上下文），也做写（落成待合入草稿）。
     * 所以它的动词表是 {@link #WIKI_WRITE_WORDS} 的<b>超集</b> —— 这条必须保持，
     * 否则会出现「写意图成立但工具意图不成立」，启动了 Agent 却不给它写工具。
     */
    private static final List<String> WIKI_TOOL_VERB_WORDS = List.of(
            "记录", "写到", "写入", "写进", "整理到", "同步到", "更新", "补充", "新建",
            "存到", "存进", "存入", "保存", "收录", "放进", "放到", "加入", "记到", "记进",
            "查", "看看", "找", "读");

    /** 「这句话要求把计划提取成任务草稿吗」—— 唯一定义。 */
    public static boolean taskCreationIntent(String message) {
        return containsAny(message, TASK_CREATE_PLAN_WORDS) && containsAny(message, TASK_CREATE_VERB_WORDS);
    }

    /** 「这句话要用 Wiki 工具循环吗」（读或写）—— 唯一定义。 */
    public static boolean wikiToolIntent(String message) {
        String text = message == null ? "" : message.toLowerCase(Locale.ROOT).replaceAll("\\s+", "");
        return WIKI_MENTION_WORDS.stream().anyMatch(text::contains)
                && WIKI_TOOL_VERB_WORDS.stream().anyMatch(text::contains);
    }

    /**
     * @param toolCallingSupported 当前模型是否支持工具调用。WIKI_TOOL_AGENT 的门是
     *        「消息意图 <b>且</b> 模型能力」—— 能力这一半不带进来的话，配了不支持工具的模型时
     *        会造出一个结构上跑不了的节点，正是刚修掉的那个形状。
     */
    public static AgentPlanDecision of(String agentMode, String message, boolean enableWebSearch,
                                       Long notebookId, Map<String, Object> contextOptions,
                                       boolean toolCallingSupported) {
        String mode = normalizeMode(agentMode);
        Map<String, Object> options = contextOptions == null ? Map.of() : contextOptions;
        boolean chatOnly = "CHAT_ONLY".equals(mode);

        boolean includeWiki = Boolean.TRUE.equals(options.get(ContextOptionKeys.INCLUDE_WIKI))
                || hasNonEmptyList(options.get(ContextOptionKeys.SELECTED_WIKI_PAGE_IDS));
        boolean hasSelectedSources = hasNonEmptyList(options.get(ContextOptionKeys.SELECTED_SOURCE_IDS));
        boolean needsNotebook = !chatOnly && notebookId != null;
        boolean needsWeb = !chatOnly && enableWebSearch;
        // hasSelectedSources 这一项来自执行侧，是本次合并里「保留行为」的那一条：
        // 少了它，用户勾选资料源却不再触发检索。
        boolean needsRetriever = !chatOnly
                && ("RESEARCH".equals(mode) || needsNotebook || needsWeb || includeWiki || hasSelectedSources);

        return new AgentPlanDecision(
                mode,
                needsRetriever,
                needsNotebook,
                needsWeb,
                includeWiki,
                plannerNeeded(mode, message),
                containsAny(message, TASK_DRAFT_WORDS),
                wikiWriteIntent(message),
                containsAny(message, MEMORY_DRAFT_WORDS),
                taskCreationIntent(message),
                wikiToolIntent(message) && toolCallingSupported
        );
    }

    private static boolean plannerNeeded(String mode, String message) {
        if ("PLAN".equals(mode)) {
            return true;
        }
        if ("CHAT_ONLY".equals(mode) || "RESEARCH".equals(mode)) {
            return false;
        }
        return containsAny(message, PLANNER_WORDS);
    }

    /**
     * 「这句话要求把内容写进 Wiki 吗」—— <b>唯一定义</b>，建图、执行、工具下发三处共用。
     *
     * <p>公开是因为非流式 {@code chat()} 与 Wiki 工具循环也要问同一个问题；
     * 让它们各自留一份就是这一轮反复在消灭的那个物种。
     */
    public static boolean wikiWriteIntent(String message) {
        String text = message == null ? "" : message.toLowerCase(Locale.ROOT).replaceAll("\\s+", "");
        return WIKI_MENTION_WORDS.stream().anyMatch(text::contains)
                && WIKI_WRITE_WORDS.stream().anyMatch(text::contains);
    }

    private static boolean containsAny(String message, List<String> words) {
        String text = message == null ? "" : message.toLowerCase(Locale.ROOT);
        return words.stream().anyMatch(text::contains);
    }

    private static boolean hasNonEmptyList(Object value) {
        return value instanceof List<?> list && !list.isEmpty();
    }
}
