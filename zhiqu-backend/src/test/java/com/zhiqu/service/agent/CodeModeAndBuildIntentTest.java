package com.zhiqu.service.agent;

import com.zhiqu.SourceText;
import com.zhiqu.service.ContextOptionKeys;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 「造一个东西」的门，和输入框旁的「代码」开关。
 *
 * <p>由来（2026-09-23）：工作区在界面上已经切到「读+写+运行」，用户说
 * <b>「帮我做一个小游戏，放在test文件夹里」</b>，得到的是「我无法直接操作你的电脑」。
 * 那一轮的执行图里根本没有 CODE_AGENT —— 读门的动作词表里没有「做」，写门的词表里没有「放在」。
 * 两层都漏了。
 *
 * <p>补词只能补到下一次漏为止，所以同时加了显式开关：用户按下「代码」，这一轮就不再猜。
 * 这里两件事都钉：词表的正反例（每一条都是 2026-09-23 实测过的说法），
 * 以及开关<b>不能</b>绕过工作区本身的前提。
 */
class CodeModeAndBuildIntentTest {

    private static final Path AI_SERVICE =
            Path.of("src", "main", "java", "com", "zhiqu", "service", "impl", "AiServiceImpl.java");
    /** 拆第五刀之后执行侧的门住在这里 —— 见 CodeAgentGateTest.CODE_AGENT 的说明。 */
    private static final Path CODE_AGENT =
            Path.of("src", "main", "java", "com", "zhiqu", "service", "ai", "CodeWorkspaceAgent.java");

    private static AgentPlanDecision decide(String message, Map<String, Object> options,
                                            boolean toolCalling, boolean workspaceReadable) {
        return AgentPlanDecision.of("AUTO", message, false, null, options, toolCalling, false, workspaceReadable);
    }

    @Test
    @DisplayName("「造一个东西」的说法要能拉起 code agent，并且拿到写工具")
    void 造东西的说法要能触发() {
        List<String> said = List.of(
                "帮我做一个小游戏，放在test文件夹里",      // 2026-09-23 漏掉的原话
                "写个贪吃蛇", "生成一个网页版计算器", "帮我做一个五子棋", "整一个俄罗斯方块玩玩",
                "新建一个html放到工作区", "帮我写个小工具批量改文件名", "做一个番茄钟网页",
                "在test文件夹里生成一个扫雷游戏", "帮我开发一个记单词的小程序", "帮我做一个背单词app",
                "给我生成一段代码放到工作区", "用 JS 做一个时钟", "帮我实现一个二分查找",
                "写个python脚本管理学习计划");
        for (String s : said) {
            assertTrue(AgentPlanDecision.codeAgentIntent(s), "没拉起 code agent：「" + s + "」");
            // 造出来的就是文件 —— 读得到却写不了，模型只能回一句「把代码复制过去」
            assertTrue(AgentPlanDecision.codeWriteIntent(s), "拉起来了但没给写工具：「" + s + "」");
        }
    }

    /** 每一条都是实测过会被词袋误伤、然后专门收窄过的说法。 */
    @Test
    @DisplayName("学习语境里的「做一个 / 写一个」不算造东西")
    void 与编程无关的造东西不算() {
        List<String> said = List.of(
                "帮我做一个复习计划", "帮我做一个应用题", "帮我写一个知识页面", "做一个游戏化的复习方案",
                "帮我写一个作文提纲", "今天玩了一个小游戏，好累", "帮我生成一个学习计划",
                "给我做个表格记录每天背单词", "帮我写个总结", "帮我整一个周末安排",
                "把这份笔记放在复习文件夹里", "帮我做个决定", "帮我做一个待办清单",
                "把这个结论写到复习目录里", "目录里存在的问题帮我写一下",
                "帮我做一个python学习计划", "帮我做一个算法复习计划");
        for (String s : said) {
            assertFalse(AgentPlanDecision.buildIntent(s), "误伤：「" + s + "」被当成了造东西");
            assertFalse(AgentPlanDecision.codeWriteIntent(s),
                    "误伤：「" + s + "」拿到了写工具 —— 用户会看到一个没要的改文件确认框");
        }
    }

    /**
     * 只看当前一条消息的门接不住这一类 —— 它缺的是上下文，不是词。
     * 钉在这里是为了别让下一个人往词表里塞「写进去」「放进去」：那会把无数句话拉进来。
     * 这一类由「代码」开关兜底。
     */
    @Test
    @DisplayName("已知接不住的那一类：依赖上一轮的追问（由「代码」开关兜底）")
    void 已知接不住的追问() {
        assertFalse(AgentPlanDecision.codeAgentIntent("那你直接写进去吧"));
        assertTrue(AgentPlanDecision.codeAgentIntent("那你直接写进去吧", Map.of(ContextOptionKeys.CODE_MODE, true)),
                "按下「代码」之后，追问也必须能拉起 code agent —— 这正是开关存在的理由");
    }

    @Test
    @DisplayName("按下「代码」：任何一句话都造出 CODE_AGENT，并且给写工具")
    void 开关按下即启用() {
        Map<String, Object> on = Map.of(ContextOptionKeys.CODE_MODE, true);
        assertTrue(decide("你好", on, true, true).needsCodeAgent(),
                "按了「代码」却没造 CODE_AGENT —— 用户明说了要它干活");
        assertTrue(AgentPlanDecision.codeWriteIntent("你好", on));
        assertFalse(decide("你好", Map.of(), true, true).needsCodeAgent(), "没按开关时「你好」不该拉起 code agent");
    }

    /**
     * 开关只替代「猜意图」这一半，<b>不</b>替代工作区的前提。
     * 工作区不可读（没开、没绑回环、不是管理员）时按了也不能造节点 ——
     * 那会是一个结构上跑不了的幽灵节点，也是一条绕过回环前提的路。
     */
    @Test
    @DisplayName("开关不能绕过前提：工作区不可读或模型不支持工具时，按了也不启用")
    void 开关不能绕过工作区前提() {
        Map<String, Object> on = Map.of(ContextOptionKeys.CODE_MODE, true);
        assertFalse(decide("帮我做一个小游戏", on, true, false).needsCodeAgent(), "工作区不可读时按开关造出了 CODE_AGENT");
        assertFalse(decide("帮我做一个小游戏", on, false, true).needsCodeAgent(), "模型不支持工具调用时按开关造出了 CODE_AGENT");
    }

    /** 这个键决定要不要给写权限：认错一个值的代价是用户没要的写工具。 */
    @Test
    @DisplayName("开关只认字面 true —— 字符串 \"true\"、数字 1 都不算")
    void 开关只认字面true() {
        assertFalse(AgentPlanDecision.codeModeRequested(Map.of(ContextOptionKeys.CODE_MODE, "true")));
        assertFalse(AgentPlanDecision.codeModeRequested(Map.of(ContextOptionKeys.CODE_MODE, 1)));
        assertFalse(AgentPlanDecision.codeModeRequested(Map.of(ContextOptionKeys.CODE_MODE, false)));
        assertFalse(AgentPlanDecision.codeModeRequested(null));
        assertTrue(AgentPlanDecision.codeModeRequested(Map.of(ContextOptionKeys.CODE_MODE, true)));
    }

    /**
     * 执行侧必须把 contextOptions 传进同一道门。
     *
     * <p>只改建图侧的话，按下开关时图里造出 CODE_AGENT，runner 开头却只看消息文本、直接返回空 ——
     * 用户在执行轨迹里看到一个什么也没做的「代码工作区」方块。这正是 2026-09-21
     * {@code practiceIntent} 只接了一半时的形状。
     */
    @Test
    @DisplayName("执行侧的读门与写门都要带上 contextOptions，与建图侧同一个表达式")
    void 执行侧必须带上开关() throws IOException {
        String code = SourceText.stripComments(Files.readString(CODE_AGENT, StandardCharsets.UTF_8));
        String service = SourceText.stripComments(Files.readString(AI_SERVICE, StandardCharsets.UTF_8))
                .replaceAll("\\s+", " ");
        assertTrue(code.contains("AgentPlanDecision.codeAgentIntent(userMessage, contextOptions)"),
                "runCodeWorkspaceAgent 的入口门没带 contextOptions —— 按了开关，图里有节点，runner 却返回空");
        int at = code.indexOf("boolean canWrite =");
        assertTrue(at > 0, "找不到 canWrite —— 判据的锚点没了");
        String statement = code.substring(at, code.indexOf(';', at) + 1);
        assertTrue(statement.contains("codeWriteIntent(userMessage, contextOptions)"),
                "canWrite 没带 contextOptions —— 按了开关却拿不到写工具，模型只会说「复制过去」。实际：" + statement);
        // 调用跨了行，按空白归一化后再找
        assertTrue(service.contains("codeWorkspaceAgent.run(s.config, s.userId, s.limitedMessage, chatHistory, s.contextOptions,"),
                "调用 CodeWorkspaceAgent.run 时没把本轮的 contextOptions 传进去");
    }
}
