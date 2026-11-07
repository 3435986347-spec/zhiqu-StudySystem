package com.zhiqu.service.agent;

import com.zhiqu.SourceText;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 代码工作区 agent 的门：三个条件缺一不可，而且<b>唯一定义</b>。
 *
 * <h2>为什么「工作区是否可读」要算进门里</h2>
 *
 * <p>不算进去的话，工作区关着时也会造出一个 {@code CODE_AGENT} 节点 —— 它跑起来什么都做不了，
 * 在执行轨迹里留下一个白占位置的方块。那正是本仓库前几轮反复清掉的<b>幽灵节点</b>，
 * 而 {@code AgentGraphOrderDerivationTest} 现在会因为「图里有执行侧没有的 agent」直接抛异常。
 *
 * <h2>为什么要有「只提到代码但没动作」的反例</h2>
 *
 * <p>「我最近在写代码」不该把一整套文件工具塞给模型：那会让它去翻不相干的文件，
 * 既慢又容易答偏。与 {@code wikiToolIntent} 同构 —— 提到 + 动作，两个都要。
 */
class CodeAgentGateTest {
    private static final Path AI_SERVICE =
            Path.of("src/main/java/com/zhiqu/service/impl/AiServiceImpl.java");
    /**
     * 拆第五刀之后 code agent 的循环、工具、执行器都住在这里。
     *
     * <p>搬家会让判据扫错文件，而扫错文件的判据看起来和通过一模一样（第二刀踩过）。
     * 所以每条判据都按「这条性质现在住在哪」读对应的文件；{@code assertFalse} 类的两个文件都查 ——
     * 只查旧文件的话，代码一搬走它就自动变绿。
     */
    private static final Path CODE_AGENT =
            Path.of("src/main/java/com/zhiqu/service/ai/CodeWorkspaceAgent.java");

    private static String src(Path p) throws IOException {
        return SourceText.stripComments(Files.readString(p, StandardCharsets.UTF_8));
    }

    /** 从 open（一个 '{' 的位置）找到配对的 '}'；字符串、字符字面量里的括号不算。 */
    private static int blockEnd(String code, int open) {
        int depth = 0;
        for (int i = open; i < code.length(); i++) {
            char c = code.charAt(i);
            if (c == '"' || c == '\'') {
                for (i++; i < code.length() && code.charAt(i) != c; i++) {
                    if (code.charAt(i) == '\\') i++;
                }
            } else if (c == '{') {
                depth++;
            } else if (c == '}' && --depth == 0) {
                return i;
            }
        }
        throw new AssertionError("找不到配对的 } —— 判据的锚点没了");
    }

    private static AgentPlanDecision decide(String message, boolean toolCalling, boolean workspaceReadable) {
        return AgentPlanDecision.of("AUTO", message, false, null, Map.of(),
                toolCalling, false, workspaceReadable, false);
    }

    @Test
    void 提到代码并且有动作才算数() {
        assertTrue(AgentPlanDecision.codeIntent("帮我看看 src/Main.java 这段代码"));
        assertTrue(AgentPlanDecision.codeIntent("这个函数为什么会报错"));
        assertTrue(AgentPlanDecision.codeIntent("审阅一下我的项目结构"));
        assertTrue(AgentPlanDecision.codeIntent("Main.java 里那个方法怎么改"));
    }

    @Test
    void 只提到代码没有动作不算() {
        assertFalse(AgentPlanDecision.codeIntent("我最近在学代码"),
                "只是提了一句代码，不该把一整套文件工具塞给模型 —— 它会去翻不相干的文件");
        assertFalse(AgentPlanDecision.codeIntent("这本书讲的是代码规范"),
                "没有动作词就不该触发");
        assertFalse(AgentPlanDecision.codeIntent("代码很有意思"));
    }

    /**
     * 一个<b>已知的过触发</b>，钉成判据是为了让它是「选的」而不是「漏的」。
     *
     * <p>「今天写了三小时代码」会触发，因为「写」+「代码」两个词都在。词袋分不开它与
     * 「帮我写一个排序函数」—— 要区分得做意图分类，那是另一次模型往返。
     *
     * <p>刻意选了过触发这一边：过触发只是多跑一轮有界的工具循环（4 轮 / 30 秒预算 /
     * 失败不影响主回答），而漏触发意味着用户问他的代码、模型却凭空编。
     * 哪天有人想收紧，这条判据会红 —— 那时他就会读到这段说明，而不是以为自己在修一个 bug。
     */
    @Test
    void 已知会过触发的那一类() {
        assertTrue(AgentPlanDecision.codeIntent("今天写了三小时代码，有点累"),
                "这是已知且有意保留的过触发。收紧之前先读这条判据的说明："
                        + "代价不对称，漏触发比过触发糟得多");
        assertTrue(AgentPlanDecision.codeIntent("帮我写一个排序函数"),
                "而这一句必须触发 —— 它和上面那句用的是同样的词，这就是词袋分不开的原因");
    }

    @Test
    void 与代码无关的话一律不算() {
        assertFalse(AgentPlanDecision.codeIntent("帮我安排下周的复习计划"));
        assertFalse(AgentPlanDecision.codeIntent("把这条记到知识 Wiki 里"));
        assertFalse(AgentPlanDecision.codeIntent(""));
        assertFalse(AgentPlanDecision.codeIntent(null));
    }

    /**
     * 工作区关着时不得造出这个节点。
     *
     * <p>扰动：把 {@code && workspaceReadable} 去掉 → 本条红。
     */
    @Test
    void 工作区不可读时不得启用() {
        assertFalse(decide("帮我看看 Main.java 这段代码", true, false).needsCodeAgent(),
                "工作区没开时造出 CODE_AGENT，就是一个跑不了的幽灵节点");
        assertTrue(decide("帮我看看 Main.java 这段代码", true, true).needsCodeAgent(),
                "反例：三个条件都满足时必须启用，否则「一律不启用」也能让上面绿");
    }

    /** 模型不支持工具调用时同理 —— 没有工具，这个 agent 什么也做不了。 */
    @Test
    void 模型不支持工具调用时不得启用() {
        assertFalse(decide("帮我看看 Main.java 这段代码", false, true).needsCodeAgent());
    }

    /**
     * 实现侧不得另起一个判定。
     *
     * <p>本仓库已经因为「同一个门两处各判一次」分叉过：建图侧与执行侧的意图判定曾经方向相反，
     * 造出跑不了的幽灵节点。所以 {@code AiServiceImpl} 里只允许<b>调用</b>这个门，
     * 不允许自己写一套关键词。
     */
    @Test
    void 实现侧只能调用这道门不能另起一套() throws IOException {
        String code = src(CODE_AGENT);
        String service = src(AI_SERVICE);
        assertTrue(code.contains("AgentPlanDecision.codeAgentIntent("),
                "AiServiceImpl 必须调用 codeAgentIntent —— 建图侧用的就是它。"
                        + "执行侧改调别的（比如只判 codeIntent）就会分叉：图里造出 CODE_AGENT 节点，"
                        + "runner 却直接返回空，用户看到一个什么也没做的方块。2026-09-21 真发生过");
        assertFalse(code.contains("looksCodeIntent") || code.contains("private boolean codeIntent")
                        || service.contains("looksCodeIntent") || service.contains("private boolean codeIntent"),
                "不得在实现侧另写一个代码意图判定 —— 两处各判一次迟早分叉");
        assertFalse(code.contains("practiceIntent") || service.contains("practiceIntent"),
                "「刷题算不算需要 code agent」这个 OR 只能写在 AgentPlanDecision.codeAgentIntent 里。"
                        + "实现侧再拼一次就是第二份真相");
    }

    /** 执行侧问的必须是<b>生效档位</b>，不是配置里写的那一档。 */
    @Test
    void 执行侧必须问生效档位() throws IOException {
        String code = src(CODE_AGENT);
        String service = src(AI_SERVICE);
        assertTrue(code.contains("workspaces.service(userId).access().effectiveMode().allowsRead()"),
                "三个前置有一条不满足时配置写 EXEC 也只能是 OFF —— 必须问 effectiveMode，"
                        + "问 configuredMode 会让工作区在没绑回环时也造出节点");
        assertFalse(code.contains("configuredMode()") || service.contains("configuredMode()"),
                "不得用配置档位做权限判断");
    }

    /**
     * 写这道门比读那道窄，而且是刻意的。
     *
     * <p>读过触发的代价是白读几个文件；写过触发的代价是弹出一个用户没要的确认框，
     * 而确认框本身就会诱导人去点。所以「看看这段代码」只给读，「帮我改一下」才给写。
     */
    @Test
    void 写意图要同时命中代码与写动作() {
        assertTrue(AgentPlanDecision.codeWriteIntent("帮我改一下 Main.java 里那个方法"));
        assertTrue(AgentPlanDecision.codeWriteIntent("这段代码重构一下"));
        assertTrue(AgentPlanDecision.codeWriteIntent("修复 Calculator.java 的除零问题"));

        assertFalse(AgentPlanDecision.codeWriteIntent("帮我看看这段代码为什么报错"),
                "只是问原因 —— 给写工具就会诱导它产出一份用户没要的草稿");
        assertFalse(AgentPlanDecision.codeWriteIntent("审阅一下我的项目结构"));
        assertFalse(AgentPlanDecision.codeWriteIntent("帮我改一下复习计划"),
                "「改」命中了写动作，但整句与代码无关，不该开写工具");
        assertFalse(AgentPlanDecision.codeWriteIntent(""));
        assertFalse(AgentPlanDecision.codeWriteIntent(null));
    }

    /** 读意图成立、写意图不成立时，写工具<b>连声明都不能有</b>。 */
    @Test
    void 没有写意图时不得下发写工具() throws IOException {
        String code = src(CODE_AGENT);
        String service = src(AI_SERVICE);

        // 钉的是「canWrite 被传进去」这个性质，不是参数个数 —— 写死整个参数表的话，
        // 加一个无关的新参数（2026-09-21 加 canExec 时就发生了）会让判据红得莫名其妙。
        assertTrue(code.contains("AgentPlanDecision.codeWriteIntent("),
                "写意图必须问 AgentPlanDecision 那道唯一的门");
        assertFalse(code.contains("private boolean codeWriteIntent") || code.contains("looksCodeWriteIntent")
                        || service.contains("private boolean codeWriteIntent") || service.contains("looksCodeWriteIntent"),
                "不得在实现侧另写一套写意图判定 —— 两处各判一次迟早分叉");

        // 写工具给不给由 canWrite 决定，原样交给命令行那份循环（第九十七轮起它的 DraftTools.allowedTools 照着下发）
        assertTrue(code.contains("canWrite, canExec, budget, limits, onStep"), "门算出来的 canWrite 没有交给命令行那份循环");
    }

    /** 磁盘那一侧也要问档位：写意图成立但工作区是只读的，同样不能下发写工具。 */
    @Test
    void 只读档下即使有写意图也不下发写工具() throws IOException {
        String code = src(CODE_AGENT);
        // 只看 canWrite 那一条语句本身。用 code.contains("allowsWrite()") 这种全文匹配的话，
        // 这两个字符串在文件里到处都是，判据永远绿 —— 那是一条不可能红的判据。
        int at = code.indexOf("boolean canWrite =");
        assertTrue(at > 0, "找不到 canWrite 的赋值 —— 判据的锚点没了，它现在什么都没看到");
        int end = code.indexOf(';', at);
        String statement = code.substring(at, end + 1);

        assertTrue(statement.contains("allowsWrite()"),
                "canWrite 必须要求工作区本身允许写。少了这一条，只读工作区里模型照样会产出草稿，"
                        + "用户点确认才发现写不了。实际语句：" + statement);
        assertTrue(statement.contains("codeWriteIntent("),
                "canWrite 必须要求这句话确实是写意图。实际语句：" + statement);
    }

    /**
     * 读工作区也要管理员 —— 否则 {@code /api/workspace/**} 上那道管理员限制是装饰。
     *
     * <h2>两条路通向同一批文件</h2>
     *
     * <p>工作区的内容有两个出口：HTTP 端点和 AI 助手的 code agent。第一百一十五轮起登录的用户都能用（用户要的），
     * 两边都问这个账号自己的档位：没开过的是 OFF，开档位的接口只认本机的请求。
     * 所以这里钉的是「问的是这个账号」和「只有一处判定」：要是问回全局的那一份，一个账号开了档位，
     * 别的账号对助手说一句「看看 xxx」就读到他的文件夹。
     */
    @Test
    void 读工作区问的是这个账号自己的档位() throws IOException {
        String code = src(CODE_AGENT);
        String service = src(AI_SERVICE);

        int at = code.indexOf("public boolean readableBy(");
        assertTrue(at > 0, "找不到 CodeWorkspaceAgent.readableBy —— 判据的锚点没了，它现在什么都没看到");
        int end = code.indexOf('}', code.indexOf('{', at));
        String body = code.substring(at, end);

        assertTrue(body.contains("workspaces.service(userId)"),
                "读工作区要问这个账号自己的那一份。实际：" + body);
        assertTrue(body.contains("allowsRead()"),
                "也必须要求生效档位允许读。实际：" + body);

        // 两个入口都要走这一个判定，不许其中一个直接问档位
        assertEquals(0, countOccurrences(service, "effectiveMode().allowsRead()"),
                "AiServiceImpl 里又出现了一处「工作区能不能读」的判定 —— 它应当只问 codeWorkspaceAgent.readableBy");
        assertTrue(service.contains("codeWorkspaceAgent.readableBy(userId)"),
                "建图侧必须问 CodeWorkspaceAgent.readableBy —— 不问的话节点的造与不造和执行侧会分叉");
        assertEquals(1, countOccurrences(code, "effectiveMode().allowsRead()"),
                "「工作区能不能读」只允许有一处判定（workspaceReadableBy）。"
                        + "多出来的那一处迟早只改一边 —— 本仓库反复在消灭的就是这个物种");
    }

    private static int countOccurrences(String haystack, String needle) {
        int n = 0;
        for (int i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length())) {
            n++;
        }
        return n;
    }

    // ── 刷题这道门（阶段 4）───────────────────────────────────────────────

    /**
     * 刷题说法要能把 code agent 拉起来。
     *
     * <p>这一条是实测逼出来的：加 {@code practiceIntent} 之前，十一种真实说法
     * （「出道算法题考考我」「判一下我的解法」「我想刷几道题」…）
     * <b>一条都不命中</b> {@code codeIntent} 或 {@code codeWriteIntent}。
     * 也就是说整条刷题环路根本走不起来 —— 沙箱、判题、错题归档全都建好了，
     * 而用户永远走不到那里。写完一条链路要拿真实说法探一遍，不能看着代码觉得通了就算通了。
     */
    @Test
    void 刷题说法要能触发() {
        for (String said : new String[]{
                "出道算法题考考我",
                "考考我二叉树",
                "我想刷几道题",
                "帮我出一道 Python 练习题",
                "出题吧，我练一下递归",
                "判一下我的解法",
                "我的解法对吗",
                "给我出几道 leetcode"}) {
            assertTrue(AgentPlanDecision.practiceIntent(said), "应当命中刷题门：" + said);
        }
    }

    /** 与编程无关的考问不算刷题 —— 否则每次背单词都会把 code agent 拉起来读一遍文件。 */
    @Test
    void 与编程无关的考问不算刷题() {
        for (String said : new String[]{
                "考考我唐诗",
                "背一下英语单词考考我",
                "出一道题考考我历史",
                "帮我安排下周的复习计划",
                "",
                null}) {
            assertFalse(AgentPlanDecision.practiceIntent(said), "不该命中刷题门：" + said);
        }
    }

    /**
     * 已知接不住的那一类 —— 明示的取舍，不是待修的 bug。
     *
     * <p>这些说法只有在「刚才出过一道题」之后才说得通，它们缺的不是词而是<b>上下文</b>。
     * 本仓库所有的门都只看当前这一条消息；想接住它们就得让门读历史，那是另一种东西，
     * 而且会带来「上一轮的话题黏住这一轮」的新问题。
     *
     * <p>钉住它，是为了下一个人看到「判一下我写对没有」不触发时，知道这是<b>已知的</b>，
     * 并且知道代价是什么 —— 而不是当成漏洞随手往词表里塞两个词。
     * 用户把学科再说一遍（「判一下我这个递归的解法」）就能命中。
     */
    @Test
    void 已知接不住的那一类() {
        for (String said : new String[]{
                "给我出一道题",
                "跑一下测试看我写对没有",
                "复盘一下刚才那道题"}) {
            assertFalse(AgentPlanDecision.practiceIntent(said),
                    "这一条目前<b>刻意</b>不命中（缺的是上下文不是词）。"
                            + "如果你让它命中了，请连同这条判据一起改，并想清楚"
                            + "「出一道题」在背单词语境下被误触的代价：" + said);
        }
        // 补一个学科词就该命中 —— 证明上面那些不是被别的东西挡住了
        assertTrue(AgentPlanDecision.practiceIntent("判一下我这个递归的写法对不对"),
                "把学科说出来就该命中。不命中说明挡住它们的不是「缺上下文」，"
                        + "而是词表本身有问题，上面那条注释就是错的");
    }

    /** 刷题要能写题目文件 —— 题目和测试用例得落到工作区里他才跑得了。 */
    @Test
    void 刷题要能写题目文件() {
        assertTrue(AgentPlanDecision.codeWriteIntent("出道算法题考考我"),
                "出题要写文件。写工具不下发的话，AI 只能把题目贴在聊天里，用户没法跑");
        assertTrue(AgentPlanDecision.codeWriteIntent("我想刷几道题"));
        assertFalse(AgentPlanDecision.codeWriteIntent("考考我唐诗"),
                "与编程无关的考问不该打开写工具");
    }

    /** 建图与执行都要认这道门，而且不许另写一套。 */
    @Test
    void 刷题门必须汇入needsCodeAgent() throws IOException {
        assertTrue(decide("出道算法题考考我", true, true).needsCodeAgent(),
                "刷题说法必须能造出 CODE_AGENT 节点 —— 造不出的话整条环路走不起来");
        assertFalse(decide("出道算法题考考我", true, false).needsCodeAgent(),
                "工作区不可读时仍然不得启用");

        String code = src(CODE_AGENT);
        String service = src(AI_SERVICE);
        assertFalse((code.contains("practiceIntent") && code.contains("PRACTICE_"))
                        || (service.contains("practiceIntent") && service.contains("PRACTICE_")),
                "不得在实现侧另写一套刷题判定 —— 词表只能有一份，在 AgentPlanDecision 里");
    }

    // ── 项目式引导（阶段 5）──────────────────────────────────────────────

    /** 项目式说法要能把 code agent 拉起来 —— 同样是先实测再补门。 */
    @Test
    void 项目式说法要能触发() {
        for (String said : new String[]{
                "带我做一个小项目",
                "我想做一个待办清单的小项目",
                "帮我规划一下这个项目怎么一步步做",
                "这个项目分几个里程碑",
                "带我从零写一个爬虫",
                "我想边做边学 Python，带我做个东西",
                "这个项目接下来做什么",
                "把里程碑排成任务",
                "帮我把这个项目拆成几步"}) {
            assertTrue(AgentPlanDecision.projectIntent(said), "应当命中项目门：" + said);
        }
    }

    /**
     * 「带着做」「分几步」不带学科时不算项目式引导。
     *
     * <p>第一版把 {@code 带我做} / {@code 分几步} 放在<b>单独成立</b>那一档，实测把
     * 「带我做一道红烧肉」「分几步走完这个学期」也拉了进来 —— 它们只说了「带着做」
     * 和「拆步骤」，没说在做什么。降到需要配学科的那一档之后才对。
     */
    @Test
    void 与编程无关的带着做不算项目式引导() {
        for (String said : new String[]{
                "带我做一道红烧肉",
                "分几步走完这个学期",
                "下一步复习什么",
                "接下来吃什么",
                "",
                null}) {
            assertFalse(AgentPlanDecision.projectIntent(said), "不该命中项目门：" + said);
        }
    }

    /** 与刷题门同一个已知限制：单条消息的门看不到「在谈哪个项目」。 */
    @Test
    void 项目门已知接不住的那一类() {
        assertFalse(AgentPlanDecision.projectIntent("下一步我该写什么"),
                "缺的是上下文不是词 —— 与 practiceIntent 同一个限制，改之前先读那条注释");
        assertTrue(AgentPlanDecision.projectIntent("这个项目下一步我该写什么"),
                "把项目说出来就该命中；不命中说明挡住它的不是「缺上下文」而是词表本身有问题");
    }

    /**
     * 里程碑要能变成任务草稿 —— 这条链路有<b>两处</b>断点，都不会报错。
     *
     * <ol>
     *   <li>{@code needsTaskDraft} 不含 {@code projectIntent} 时，图里没有 TASK_DRAFTER 节点，
     *       {@code TaskDrafterRunner.inGraph} 为假，它根本不跑 —— CODE_AGENT 把里程碑放进
     *       {@code suggestedPlan} 了，却没有人把它变成工件。</li>
     *   <li>{@code PlanExtractorRunner} 在 POST_STREAM <b>无条件</b>赋值 {@code suggestedPlan}，
     *       而 {@code suggestPlanFromChatIfNeeded} 在非 taskCreationIntent 时必然返回空计划 ——
     *       里程碑在这里被悄悄抹掉。</li>
     * </ol>
     *
     * <p>两处都是「看起来接通、实际永远产不出东西」，日志和执行轨迹上都看不出来。
     */
    @Test
    void 里程碑必须能落成任务草稿() throws IOException {
        assertTrue(decide("带我做一个小项目", true, true).needsTaskDraft(),
                "项目式引导必须造出 TASK_DRAFTER 节点，否则里程碑变不成草稿");
        assertTrue(decide("这个项目分几个里程碑", true, true).needsTaskDraft());

        String code = SourceText.stripComments(Files.readString(AI_SERVICE, StandardCharsets.UTF_8));
        assertFalse(code.contains("s.suggestedPlan = suggestPlanFromChatIfNeeded("),
                "PLAN_EXTRACTOR 不得无条件覆盖 suggestedPlan —— 非 taskCreationIntent 的那一轮"
                        + "它拿到的必然是空计划，会把 CODE_AGENT 放进去的里程碑抹掉");
        assertTrue(code.contains("if (hasPlanDraft(extracted) || !hasPlanDraft(s.suggestedPlan))"),
                "覆盖前必须判一次：空的不许盖掉非空的");

        // 里程碑必须走既有的那条路，不许另建工件类型或直接落库
        assertTrue(code.contains("s.suggestedPlan = codeResult.milestonePlan();"),
                "里程碑要交给既有的 TASK_DRAFT / ROUTINE_DRAFT 路径");
        String agent = src(CODE_AGENT);
        assertFalse(code.contains("\"MILESTONE_DRAFT\"") || agent.contains("\"MILESTONE_DRAFT\""),
                "不得新建里程碑专用的工件类型 —— 确认分支、前端弹窗、落库全都要跟着改一遍");
        // schema 只有一份：code agent 用的是借来的 planning.tools()，自己不许再声明一个 create_study_plan
        assertTrue(agent.contains("studyPlanTool.tools()"), "code agent 没用 StudyPlanTool 那一份 schema");
        assertFalse(agent.contains("functionTool(\"create_study_plan\""),
                "CodeWorkspaceAgent 里另写了一份 create_study_plan 声明 —— 两份迟早分叉，落库时静默丢字段");
        assertTrue(code.contains("studyPlanTool.tools()"),
                "里程碑的 schema 必须复用 create_study_plan，另猜字段名会在落库时静默丢掉"
                        + "象限、时长、截止日期");
    }

    /** 只有项目式引导才给「排任务」的能力 —— 别的语境下模型不该往用户日历里塞东西。 */
    @Test
    void 非项目语境不得下发排任务的工具() throws IOException {
        String code = src(CODE_AGENT);
        int at = code.indexOf("boolean canPlanMilestones =");
        assertTrue(at > 0, "找不到 canPlanMilestones 的赋值 —— 判据的锚点没了");
        String statement = code.substring(at, code.indexOf(';', at) + 1);
        assertTrue(statement.contains("projectIntent("),
                "canPlanMilestones 必须由 projectIntent 决定。实际：" + statement);

        int declaration = code.indexOf("studyPlanTool.tools()");
        int gate = code.indexOf("if (canPlanMilestones) {");
        assertTrue(gate > 0, "排任务的工具必须收在 if (canPlanMilestones) 里");
        assertTrue(code.indexOf("studyPlanTool.tools()", gate) > gate,
                "工具声明要在门里面；无条件下发的话，用户问「这段代码为什么报错」"
                        + "模型也会顺手往他日历里排一串任务。首个声明位置：" + declaration);
    }
}
