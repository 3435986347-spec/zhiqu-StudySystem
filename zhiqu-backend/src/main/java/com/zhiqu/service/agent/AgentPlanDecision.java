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
        boolean needsWikiTool,
        boolean needsCodeAgent,
        boolean needsAnswerVerifier,
        boolean needsSummary
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

    /**
     * 提到「代码」这件事的词。
     *
     * <p>刻意包含常见语言与文件后缀：用户说「看看我这个 Main.java」时不会再说一遍「代码」。
     */
    private static final List<String> CODE_MENTION_WORDS = List.of(
            "代码", "源码", "工程", "项目", "函数", "方法", "类", "接口", "报错", "编译", "调试",
            "bug", "code", "java", "python", "javascript", "typescript", "golang", "sql",
            ".java", ".py", ".js", ".ts", ".go", ".c", ".cpp", ".rs", ".sql",
            "仓库", "工作区", "文件夹", "目录结构");

    /** 对代码做事情的动词。与 Wiki 那套同构：提到 + 动作，两个都要。 */
    private static final List<String> CODE_ACTION_WORDS = List.of(
            "看看", "读", "查", "找", "解释", "讲讲", "说明", "审阅", "review", "检查",
            "改", "修", "重构", "优化", "补", "写", "实现", "生成", "跑", "运行", "测试",
            "为什么", "怎么", "哪里", "是不是");

    /**
     * 「这句话要用工作区的代码工具吗」—— <b>唯一定义</b>。
     *
     * <p>与 {@link #wikiToolIntent} 同构：提到代码 + 有动作，两个都要。只提「代码」不给动作
     * （「我最近在写代码」）不该把一整套文件工具塞给模型 —— 那既慢又容易让它去翻不相干的文件。
     *
     * <p><b>不要在 {@code AiServiceImpl} 里另起一个判定。</b>本仓库已经因为「同一个门两处各判一次」
     * 分叉过：建图侧与执行侧的意图判定曾经方向相反，造出跑不了的幽灵节点。
     *
     * <h2>一个已知的过触发，以及为什么留着它</h2>
     *
     * <p>词袋分不开「帮我<b>写</b>一个排序函数」（该触发）与「今天<b>写</b>了三小时代码，有点累」
     * （不该触发）—— 两句用的词是一样的。要区分得做意图分类，那是另一次模型往返，
     * 为一个门付这个代价不值。
     *
     * <p>所以刻意选了过触发这一边。两种错的代价不对称：
     * 过触发只是多跑一轮<b>有界的</b>工具循环（4 轮、30 秒预算、失败不影响主回答），
     * 而漏触发意味着用户问他的代码、模型却凭空编 —— 后者在一个学习系统里要糟得多。
     */
    public static boolean codeIntent(String message) {
        String text = message == null ? "" : message.toLowerCase(Locale.ROOT).replaceAll("\\s+", "");
        return CODE_MENTION_WORDS.stream().anyMatch(text::contains)
                && CODE_ACTION_WORDS.stream().anyMatch(text::contains);
    }

    /** 「这句话要用 Wiki 工具循环吗」（读或写）—— 唯一定义。 */
    public static boolean wikiToolIntent(String message) {
        String text = message == null ? "" : message.toLowerCase(Locale.ROOT).replaceAll("\\s+", "");
        return WIKI_MENTION_WORDS.stream().anyMatch(text::contains)
                && WIKI_TOOL_VERB_WORDS.stream().anyMatch(text::contains);
    }

    /**
     * @param historyFull 本轮历史是否已经填满窗口（{@code ChatWriteContext.historyFull}：条数取满，或被字数裁掉过）。
     *        这是「可能需要压缩」的<b>必要条件</b>：窗口没满就一定没有消息滑出去，压缩无从谈起。
     *        不是充分条件 —— 真正要不要重算还看「自上次摘要以来新滑出多少条」，
     *        那要查库，不该放进这个纯函数里。节点造出来而这一轮没轮到压缩时，
     *        runner 什么都不做、由 settleUnrunTasks 收成 SKIPPED，与 TASK_DRAFTER 同一个写法。
     * @param toolCallingSupported 当前模型是否支持工具调用。WIKI_TOOL_AGENT 的门是
     *        「消息意图 <b>且</b> 模型能力」—— 能力这一半不带进来的话，配了不支持工具的模型时
     *        会造出一个结构上跑不了的节点，正是刚修掉的那个形状。
     */
    public static AgentPlanDecision of(String agentMode, String message, boolean enableWebSearch,
                                       Long notebookId, Map<String, Object> contextOptions,
                                       boolean toolCallingSupported, boolean historyFull,
                                       boolean workspaceReadable) {
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
                // 项目式引导也要造 TASK_DRAFTER 节点：里程碑要靠它变成 TASK_DRAFT 工件。
                // 不加这一条的话，CODE_AGENT 把里程碑放进 suggestedPlan 了，而没有节点的
                // TaskDrafterRunner 根本不会跑 —— 整条路看起来接通，实际永远产不出草稿。
                containsAny(message, TASK_DRAFT_WORDS) || projectIntent(message),
                wikiWriteIntent(message),
                containsAny(message, MEMORY_DRAFT_WORDS),
                taskCreationIntent(message),
                wikiToolIntent(message) && toolCallingSupported,
                // 三个条件缺一不可。workspaceReadable 来自执行侧（WorkspaceAccess 的生效档位）——
                // 工作区没开时造出这个节点，就是一个结构上跑不了的幽灵节点，
                // 而那正是 AgentGraphOrderDerivationTest 在防的形状。
                codeAgentIntent(message, options) && toolCallingSupported && workspaceReadable,
                // 没检索就没有引用可核 —— 与 needsRetriever 同条件，不另起一个会漂的门
                needsRetriever,
                historyFull
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

    /**
     * 刷题动作词 —— <b>足够具体、单独就能成立</b>的那一档。
     *
     * <p>「我的解法」「练习题」「判题」这些词出现在非编程语境里很少见，
     * 所以不再要求第二个信号。漏触发的代价比过触发大得多：用户说「判一下我的解法」
     * 却得到一段泛泛而谈，他<b>看不出</b>本来可以真的跑一遍测试 —— 这个功能对他而言
     * 等于不存在。
     */
    private static final List<String> PRACTICE_STRONG_WORDS = List.of(
            "刷题", "刷几道", "刷一道", "练习题", "习题", "判题", "算法题", "代码题",
            "我的解法", "我的答案", "我的实现", "测试用例", "leetcode", "力扣", "acm");

    /**
     * 通用的那一档 —— 单独不算，要配一个学科或代码信号。
     *
     * <p>「考考我」「出一道题」本身不带学科：用户可能在背单词、在背历史。
     * 单独成立的话，每次都会把 code agent 拉起来读一遍文件，白花轮次。
     */
    private static final List<String> PRACTICE_WEAK_WORDS = List.of(
            "出题", "出一道", "出一题", "出几道", "出道", "考考我", "考我", "判一下",
            "做几道", "写对没有");

    /** 编程练习的学科词。{@link #CODE_MENTION_WORDS} 之外的那一半 —— 它只有代码名词，没有算法名词。 */
    private static final List<String> PRACTICE_SUBJECT_WORDS = List.of(
            "算法", "数据结构", "递归", "动态规划", "回溯", "贪心", "链表", "二叉树", "哈希",
            "图论", "排序", "查找", "复杂度", "指针", "并发", "编程", "字符串处理");

    /**
     * 「这句话是在刷题 / 练习吗」—— 第三道门，与 {@link #codeIntent} 并列汇入 needsCodeAgent。
     *
     * <h2>已知会漏触发的那一类，以及为什么不修</h2>
     *
     * <p>这些说法<b>不会</b>命中：「给我出一道题」「跑一下测试看我写对没有」「复盘一下刚才那道题」。
     * 它们缺的不是词，是<b>上下文</b> —— 只有在「刚才出过一道题」之后才说得通，
     * 而本仓库所有的门都只看<b>当前这一条消息</b>。想接住它们就得让门读历史，
     * 那是另一种东西（而且会带来「上一轮的话题黏住这一轮」的新问题）。
     *
     * <p>所以这里明说：单条消息的关键词门接不住对话中的后续追问。用户把学科再说一遍
     * （「判一下我这个递归的解法」）就能命中。
     */
    public static boolean practiceIntent(String message) {
        String text = message == null ? "" : message.toLowerCase(Locale.ROOT).replaceAll("\\s+", "");
        if (PRACTICE_STRONG_WORDS.stream().anyMatch(text::contains)) {
            return true;
        }
        return PRACTICE_WEAK_WORDS.stream().anyMatch(text::contains)
                && (PRACTICE_SUBJECT_WORDS.stream().anyMatch(text::contains)
                    || CODE_MENTION_WORDS.stream().anyMatch(text::contains));
    }

    /**
     * 项目式引导的动作词 —— 足够具体、单独就能成立的那一档。
     *
     * <p>「里程碑」「小项目」「带我做」「边做边学」这些词几乎只出现在「带着我从零做一个东西」
     * 这个语境里。与刷题门同一个理由：漏触发的代价是这个功能对用户而言等于不存在。
     */
    private static final List<String> PROJECT_STRONG_WORDS = List.of(
            "小项目", "里程碑", "带我从零", "从零写", "从零做",
            "项目计划", "练手项目", "实战项目");

    /**
     * 通用的那一档 —— 单独不算，要配一个代码或学科信号。
     *
     * <p>「下一步」「接下来」出现在任何话题里：下一步复习什么、接下来吃什么。
     * 单独成立就会把 code agent 拉起来读一遍文件。
     */
    private static final List<String> PROJECT_WEAK_WORDS = List.of(
            "下一步", "接下来", "一步步", "该写什么", "怎么开始", "从哪开始", "从哪里开始",
            // 这几个第一版放在 STRONG 里，实测把「带我做一道红烧肉」「分几步走完这个学期」
            // 也拉了进来 —— 它们只说了「带着做」和「拆步骤」，没说是在做什么。
            "带我做", "从头做", "边做边学", "拆成几步", "分几步");

    /**
     * 「这句话是在要项目式引导吗」—— 第四道门，与 {@link #codeIntent}、{@link #practiceIntent}
     * 并列汇入 {@link #codeAgentIntent}。
     *
     * <h2>已知接不住的那一类</h2>
     *
     * <p>「下一步我该写什么」不会命中：它缺的是<b>上下文</b>（在谈哪个项目），
     * 而本仓库所有的门都只看当前这一条消息。与刷题门同一个已知限制，
     * 理由与代价见 {@link #practiceIntent}。用户带上项目或语言名就能命中。
     */
    public static boolean projectIntent(String message) {
        String text = message == null ? "" : message.toLowerCase(Locale.ROOT).replaceAll("\\s+", "");
        if (PROJECT_STRONG_WORDS.stream().anyMatch(text::contains)) {
            return true;
        }
        return PROJECT_WEAK_WORDS.stream().anyMatch(text::contains)
                && (CODE_MENTION_WORDS.stream().anyMatch(text::contains)
                    || PRACTICE_SUBJECT_WORDS.stream().anyMatch(text::contains));
    }

    /**
     * 「这一轮的<b>意图</b>需要 code agent 吗」—— 建图侧与执行侧共用的<b>唯一</b>表达式。
     *
     * <p>存在的理由只有一个：这个 OR 不能写两遍。2026-09-21 加 {@code practiceIntent} 时
     * 只改了建图侧（{@code of(...)}），执行侧 {@code runCodeWorkspaceAgent} 开头判的还是
     * {@code codeIntent} —— 于是刷题那一轮图里造出了 CODE_AGENT 节点，而 runner 直接返回空：
     * 用户在执行轨迹里看到一个「代码工作区」的方块，它什么也没做。
     *
     * <p>注意这里<b>只</b>管意图。工具调用支持与工作区可读性由调用方各自补上 ——
     * 它们一个依赖模型配置、一个依赖用户身份，不属于「这句话想干什么」。
     */
    public static boolean codeAgentIntent(String message) {
        return codeIntent(message) || practiceIntent(message) || projectIntent(message) || buildIntent(message);
    }

    /**
     * 同上，再加上用户<b>显式</b>按下的「代码」开关。建图侧与执行侧都调这一个。
     *
     * <p>开关与关键词是 OR，不是替代：没按按钮时关键词门照常工作。
     */
    public static boolean codeAgentIntent(String message, Map<String, Object> contextOptions) {
        return codeModeRequested(contextOptions) || codeAgentIntent(message);
    }

    /**
     * 用户按下了「代码」按钮 —— 只认字面 {@code true}。
     *
     * <p>{@code "true"} 字符串、{@code 1} 都不算：这个键决定要不要把改文件的工具交给模型，
     * 认错一个值的代价是用户没要的写权限。
     */
    public static boolean codeModeRequested(Map<String, Object> contextOptions) {
        return contextOptions != null && Boolean.TRUE.equals(contextOptions.get(ContextOptionKeys.CODE_MODE));
    }

    /**
     * 「造一个东西」的动词 —— 做 / 写 / 生成 + 一个。
     *
     * <p>2026-09-23 实测漏掉的原话是「帮我做一个小游戏，放在test文件夹里」：
     * 「做」不在 {@link #CODE_ACTION_WORDS} 里，「游戏」不在 {@link #CODE_MENTION_WORDS} 里。
     * 单独的「做」太泛（「做题」「做计划」），所以要求带量词「一个 / 个」，再配一个成品名词。
     */
    private static final List<String> BUILD_VERB_WORDS = List.of(
            "做一个", "做个", "写一个", "写个", "生成一个", "创建一个", "新建一个",
            "搭一个", "开发一个", "整一个", "弄一个", "实现一个");

    /**
     * 成品名词：说出来就是一个要写成代码的东西。
     *
     * <p>刻意<b>不收</b>：「页面」（「写一个知识页面」是 Wiki）、「应用」（「做一个应用题」是解题）、
     * 「表格」（多半是学习计划表）。每一个都实测过会把非代码的话拉进来。
     */
    private static final List<String> BUILD_OBJECT_WORDS = List.of(
            "游戏", "网页", "网站", "程序", "脚本", "小工具", "命令行工具", "计算器", "爬虫", "插件",
            "贪吃蛇", "俄罗斯方块", "扫雷", "五子棋", "番茄钟", "demo", "html", "app", "readme", "helloworld");

    /**
     * 语言名：「用 JS 做一个时钟」没有成品名词，但说了用什么语言写 —— 那就是代码。
     *
     * <p>不直接复用 {@link #CODE_MENTION_WORDS}：那里有「项目」「方法」「类」「接口」，
     * 「做一个项目计划」「写一个学习方法」会被拉进来。这里只收语言本身。
     * 「go」「ts」「c」太短，会命中 google / tests / 任何英文，所以只收带后缀的写法。
     */
    private static final List<String> BUILD_LANGUAGE_WORDS = List.of(
            "python", "java", "javascript", "js", "typescript", "html", "css", "c++", "c语言",
            "golang", "go语言", "rust", "sql", "shell", "bash");

    /** 「放进文件夹」那一支用的动词 —— 比 {@link #BUILD_VERB_WORDS} 宽，因为落点已经说明是文件。 */
    private static final List<String> PLACE_VERB_WORDS = List.of("做", "写", "生成", "创建", "新建");

    /**
     * 「放进某个文件夹」—— 说明要落到磁盘上，只可能是工作区。
     *
     * <p>不收「存在」：它更常见的意思是「有」（「目录里存在的问题」）。
     * 文件夹词不收裸的「目录」：「写到复习目录里」说的是笔记的目录。两条都是实测误伤过的。
     */
    private static final List<String> PLACE_WORDS = List.of(
            "放在", "放到", "放进", "存到", "保存到", "写到", "写进");
    private static final List<String> FOLDER_WORDS = List.of("文件夹", "工作区", "根目录", "子目录", "目录下");

    /**
     * 学习产物词：出现它们时，「造 + 语言 / 算法」说的是学习安排，不是代码。
     *
     * <p>「帮我做一个 python 学习计划」「写一个 java 学习路线」实测会被拉进来 ——
     * 语言名在这里是学习的<b>对象</b>，不是写代码用的<b>工具</b>。成品名词那一支不受它影响：
     * 「写个 python 脚本管理学习计划」照样是代码。
     */
    private static final List<String> STUDY_ARTIFACT_WORDS = List.of(
            "计划", "安排", "大纲", "路线", "笔记", "总结", "提纲", "复习");

    /**
     * 「这句话是在让它造一个东西吗」—— 第五道门，汇入 {@link #codeAgentIntent} 与 {@link #codeWriteIntent}。
     *
     * <p>两种说法任一成立：造 + 成品名词（「写个贪吃蛇」），或者造 + 放进文件夹
     * （「生成一个 xx 放到工作区」）。后者没有成品名词也够了 —— 要落进文件夹的东西就是文件。
     *
     * <p>「游戏化」先剔掉再匹配：「做一个游戏化的复习方案」说的是学习方法，不是游戏。
     */
    public static boolean buildIntent(String message) {
        String text = message == null ? "" : message.toLowerCase(Locale.ROOT).replaceAll("\\s+", "").replace("游戏化", "");
        // 「生成一段代码放到工作区」：落点说了是文件夹，动词放宽 —— 要落进文件夹的东西就是文件。
        // 仍然要有一个「造」的动词：「把这份笔记放在复习文件夹里」只是在整理，不是在造。
        if (PLACE_WORDS.stream().anyMatch(text::contains) && FOLDER_WORDS.stream().anyMatch(text::contains)
                && PLACE_VERB_WORDS.stream().anyMatch(text::contains)) {
            return true;
        }
        if (BUILD_VERB_WORDS.stream().noneMatch(text::contains)) {
            return false;
        }
        // 造 + 成品（「写个贪吃蛇」）/ 造 + 语言（「用 JS 做一个时钟」）/ 造 + 算法（「实现一个二分查找」）
        if (BUILD_OBJECT_WORDS.stream().anyMatch(text::contains)) {
            return true;
        }
        boolean aboutStudyArtifact = STUDY_ARTIFACT_WORDS.stream().anyMatch(text::contains);
        return !aboutStudyArtifact
                && (BUILD_LANGUAGE_WORDS.stream().anyMatch(text::contains)
                    || PRACTICE_SUBJECT_WORDS.stream().anyMatch(text::contains));
    }


/**
     * 写代码这一侧的动作词。比 {@link #CODE_ACTION_WORDS} 窄得多，而且是刻意的。
     *
     * <p>读那道门宁可过触发（多读几个文件的代价很小），写这道门不行：
     * 写工具一旦下发给模型，它就可能产出一份「我帮你改好了」的草稿，
     * 而用户问的其实只是「这段代码为什么报错」。草稿虽然不落盘，
     * 但弹出来的确认框本身就是干扰，而且会诱导用户点确认。
     */
    private static final List<String> CODE_WRITE_WORDS = List.of(
            "改一下", "改改", "帮我改", "修改", "修一下", "修复", "重构", "改写", "补全",
            "写入", "落盘", "保存到", "创建文件", "新建文件", "加一个方法", "加个方法", "实现一下",
            "fix", "refactor", "rewrite", "implement");

    /**
     * 「这句话要求<b>改</b>工作区里的代码吗」—— 唯一定义，工具下发与判据共用。
     *
     * <p>要求同时命中代码提及词与写动作词，和 {@link #wikiWriteIntent} 同一个形状。
     * 「最小权限」：只有明确的写意图才把 {@code write_workspace_file} 下发给模型 ——
     * 不下发，它就不会尝试，也不会承诺自己改了文件。
     */
    public static boolean codeWriteIntent(String message) {
        String text = message == null ? "" : message.toLowerCase(Locale.ROOT).replaceAll("\\s+", "");
        if (CODE_MENTION_WORDS.stream().anyMatch(text::contains)
                && CODE_WRITE_WORDS.stream().anyMatch(text::contains)) {
            return true;
        }
        // 刷题与项目式引导本身就要写文件：题目、测试用例、里程碑的脚手架
        // 都得落到工作区里他才跑得了。「造一个东西」同理 —— 造出来的就是文件。
        // 仍然是草稿优先：写工具产出的是 CODE_DRAFT，他看过 diff 才落盘。
        return practiceIntent(message) || projectIntent(message) || buildIntent(message);
    }

    /**
     * 同上，再加上「代码」开关。按下开关就是明说「这一轮让你动手」——
     * 写工具照样只产出草稿，要他看过 diff 点确认才落盘，所以这里不再二次猜他想不想写。
     */
    public static boolean codeWriteIntent(String message, Map<String, Object> contextOptions) {
        return codeModeRequested(contextOptions) || codeWriteIntent(message);
    }

    private static boolean containsAny(String message, List<String> words) {
        String text = message == null ? "" : message.toLowerCase(Locale.ROOT);
        return words.stream().anyMatch(text::contains);
    }

    private static boolean hasNonEmptyList(Object value) {
        return value instanceof List<?> list && !list.isEmpty();
    }
}
