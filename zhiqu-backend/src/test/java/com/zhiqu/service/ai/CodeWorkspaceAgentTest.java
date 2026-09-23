package com.zhiqu.service.ai;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessClock;
import com.zhiqu.entity.AiModelConfig;
import com.zhiqu.service.ReminderPlanService;
import com.zhiqu.service.AdminGuard;
import com.zhiqu.service.ContextOptionKeys;
import com.zhiqu.service.KnowledgeService;
import com.zhiqu.service.workspace.WorkspaceAccess;
import com.zhiqu.service.workspace.WorkspaceExecutor;
import com.zhiqu.service.workspace.WorkspaceMode;
import com.zhiqu.service.workspace.WorkspaceService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * code agent 工具循环的<b>行为</b>判据 —— 真跑 {@link CodeWorkspaceAgent#run}，模型换成脚本。
 *
 * <p>拆第五刀之前，这个循环住在五千行的 {@code AiServiceImpl} 里，要测就得立起整个 Spring
 * 上下文，所以它的几道门只有「扫源码」式的判据：那能钉住<b>写法</b>，钉不住<b>行为</b>。
 * 搬出来之后依赖只剩六个注入的服务，这里第一次拿对抗性的模型输出去喂它。
 */
class CodeWorkspaceAgentTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir
    Path root;

    /** 一套可控的依赖：真实的档位判定（临时目录 + 回环），其余 mock。 */
    private final class Rig {
        final ModelProviderClient provider = mock(ModelProviderClient.class);
        final WorkspaceService workspace = mock(WorkspaceService.class);
        final WorkspaceExecutor executor = mock(WorkspaceExecutor.class);
        final AdminGuard adminGuard = mock(AdminGuard.class);
        final List<Map<String, Object>> notes = new ArrayList<>();
        final CodeWorkspaceAgent agent;

        Rig(WorkspaceMode mode, boolean admin) {
            when(workspace.access()).thenReturn(new WorkspaceAccess(mode, root.toString(), "127.0.0.1"));
            when(adminGuard.isAdmin(1L)).thenReturn(admin);
            when(provider.supportsToolCalling(any())).thenReturn(true);
            WikiToolAgent wiki = new WikiToolAgent(mock(KnowledgeService.class), provider, JSON);
            BusinessClock clock = mock(BusinessClock.class);
            when(clock.today()).thenReturn(LocalDate.of(2026, 9, 23));
            StudyPlanTool plans = new StudyPlanTool(clock, mock(ReminderPlanService.class), JSON);
            agent = new CodeWorkspaceAgent(provider, workspace, executor, wiki, adminGuard, JSON, plans);
        }

        /** 模型依次给出这些回复；给完之后回一条不调工具的消息，循环自然结束。 */
        void modelSays(String... replies) throws Exception {
            var stub = when(provider.callToolTurn(any(), any(), any(), any()));
            for (String r : replies) {
                stub = stub.thenReturn(JSON.readTree(r));
            }
            stub.thenReturn(JSON.readTree("{\"role\":\"assistant\",\"content\":\"好了\"}"));
        }

        CodeWorkspaceAgent.Result run(String message, Map<String, Object> options) {
            return run(message, List.of(), options);
        }

        CodeWorkspaceAgent.Result run(String message, List<Map<String, Object>> history, Map<String, Object> options) {
            return agent.run(new AiModelConfig(), 1L, message, history, options, null, notes::add);
        }

        /** 本轮所有 result 叙述拼起来 —— 被拒绝的原因会出现在这里。 */
        String results() {
            StringBuilder sb = new StringBuilder();
            for (Map<String, Object> n : notes) {
                if ("result".equals(n.get("phase"))) sb.append(n.get("message")).append('\n');
            }
            return sb.toString();
        }
    }

    private static String toolCall(String name, String argsJson) throws Exception {
        return "{\"role\":\"assistant\",\"tool_calls\":[{\"id\":\"c1\",\"type\":\"function\",\"function\":"
                + "{\"name\":\"" + name + "\",\"arguments\":" + JSON.writeValueAsString(argsJson) + "}}]}";
    }

    private static final Map<String, Object> CODE_MODE = Map.of(ContextOptionKeys.CODE_MODE, true);

    /** 不是管理员就一次模型调用都不发 —— 否则普通用户一句话就能让服务器去读自己的磁盘。 */
    @Test
    @DisplayName("非管理员：直接返回空，一次模型调用都不发")
    void 非管理员不碰模型() {
        Rig rig = new Rig(WorkspaceMode.EXEC, false);
        CodeWorkspaceAgent.Result r = rig.run("帮我看看 Main.java 这段代码", CODE_MODE);
        assertSame(CodeWorkspaceAgent.Result.EMPTY, r);
        verify(rig.provider, never()).callToolTurn(any(), any(), any(), any());
    }

    @Test
    @DisplayName("工作区是 OFF：同样直接返回空")
    void 工作区关着不碰模型() {
        Rig rig = new Rig(WorkspaceMode.OFF, true);
        assertSame(CodeWorkspaceAgent.Result.EMPTY, rig.run("帮我看看 Main.java 这段代码", CODE_MODE));
        verify(rig.provider, never()).callToolTurn(any(), any(), any(), any());
    }

    /**
     * 「下发了什么」和「能执行什么」是同一份清单。只读档下写工具没下发，
     * 模型硬报一个 write_workspace_file，也必须被拒 —— 不能产出草稿。
     */
    @Test
    @DisplayName("没下发的工具调不到：只读档下模型硬调 write_workspace_file，被拒且不产草稿")
    void 没下发的工具调不到() throws Exception {
        Rig rig = new Rig(WorkspaceMode.READ, true);
        // game.html 是个新文件：「没读过不许改」那道门对它放行。这样只要「没下发就拒绝」失守，
        // 就一定会产出草稿 —— 否则「不产草稿」这半条断言会被另一道门顶替，单独看是弱的（扰动 S2 照出来的）。
        when(rig.workspace.baselineOf("game.html")).thenReturn(WorkspaceService.ABSENT);
        rig.modelSays(toolCall("write_workspace_file", "{\"path\":\"game.html\",\"content\":\"<html></html>\"}"));
        CodeWorkspaceAgent.Result r = rig.run("帮我做一个小游戏", CODE_MODE);
        assertTrue(r.drafts().isEmpty(), "只读档下产出了草稿：" + r.drafts());
        assertFalse(r.writeOffered(), "只读档下却报告写工具下发过");
        assertTrue(rig.results().contains("这一轮没有给你「write_workspace_file」这个工具"), rig.results());
    }

    /** 对已存在的文件，没读过就改是拿想象中的内容覆盖真实内容。 */
    @Test
    @DisplayName("没读过不许改已存在的文件；新建文件不必先读，草稿标成 creating")
    void 没读过不许改() throws Exception {
        Rig rig = new Rig(WorkspaceMode.WRITE, true);
        when(rig.workspace.baselineOf("Main.java")).thenReturn("sha256:存在");
        when(rig.workspace.baselineOf("game.html")).thenReturn(WorkspaceService.ABSENT);
        rig.modelSays(
                toolCall("write_workspace_file", "{\"path\":\"Main.java\",\"content\":\"覆盖\"}"),
                toolCall("write_workspace_file", "{\"path\":\"game.html\",\"content\":\"<html></html>\"}"));
        CodeWorkspaceAgent.Result r = rig.run("帮我做一个小游戏", CODE_MODE);
        assertTrue(rig.results().contains("必须先 read_workspace_file 读过它"), "没读过就改已存在的文件，却没被拒：" + rig.results());
        assertEquals(1, r.drafts().size(), "应当只有新建的那一份草稿：" + r.drafts());
        assertEquals("game.html", r.drafts().get(0).get("path"));
        assertEquals(true, r.drafts().get(0).get("creating"));
    }

    /**
     * 里程碑参数坏了要回模型一句话，循环接着跑。
     *
     * <p>第五刀之前这里直接调 PLANNER 的解析器，它对坏 JSON 抛异常 —— 整个循环当场结束，
     * 模型连重试的机会都没有。这里用的是真实的 {@link StudyPlanTool}（第六刀），不是桩：
     * 判的是「坏 JSON 真的走到了 parseOrNull 那条不抛的路」。
     */
    @Test
    @DisplayName("里程碑解析不出来：回模型一句说明，循环继续（模型被再调一次）")
    void 里程碑坏参数不中断循环() throws Exception {
        Rig rig = new Rig(WorkspaceMode.READ, true);
        rig.modelSays(toolCall("create_study_plan", "{不是json"));
        CodeWorkspaceAgent.Result r = rig.run("带我做一个小项目", Map.of());
        verify(rig.provider, times(2)).callToolTurn(any(), any(), any(), any());
        assertEquals(null, r.milestonePlan());
        assertTrue(r.context().contains("没有解析出可用的里程碑"), r.context());
    }

    @Test
    @DisplayName("每次工具调用都先发一条 call 叙述，带上它要做什么")
    void 每一步都有叙述() throws Exception {
        Rig rig = new Rig(WorkspaceMode.READ, true);
        when(rig.workspace.read("src/Main.java")).thenReturn("class Main {}");
        rig.modelSays(toolCall("read_workspace_file", "{\"path\":\"src/Main.java\"}"));
        rig.run("帮我看看 src/Main.java 的代码", CODE_MODE);
        assertTrue(rig.notes.stream().anyMatch(n -> "call".equals(n.get("phase"))
                && "读取 src/Main.java".equals(n.get("message"))), "没有「读取 src/Main.java」这一步：" + rig.notes);
    }

    /** Wiki 的工具名只有一份定义；它必须和 buildWikiTools 真实声明出来的名字一致。 */
    @Test
    @DisplayName("WikiToolAgent.TOOL_NAMES 与 buildWikiTools(true) 实际声明的名字一致")
    void wiki工具名只有一份() {
        WikiToolAgent wiki = new WikiToolAgent(mock(KnowledgeService.class), mock(ModelProviderClient.class), JSON);
        Set<String> declared = new TreeSet<>(CodeWorkspaceAgent.offeredToolNames(wiki.buildWikiTools(true)));
        assertTrue(declared.size() >= 3, "只解析出 " + declared + " —— 扫空了");
        assertEquals(new TreeSet<>(WikiToolAgent.TOOL_NAMES), declared,
                "TOOL_NAMES 和实际声明对不上 —— code agent 会把某个 Wiki 调用当成工作区工具去执行（得到「未知的工作区工具」）");
    }


    /**
     * 追问要看得到历史。2026-09-23 命令行里真实发生的：用户说「确认创建」，工具循环只看到这四个字，
     * 列了一下目录就停；写出代码的是后面那次没有工具的最终回答，于是它说「没有可用的文件写入工具」。
     */
    @Test
    @DisplayName("追问看得到历史：「确认创建」时，上一轮助手写的代码在发给模型的消息里，写工具也下发了")
    @SuppressWarnings("unchecked")
    void 追问看得到历史() throws Exception {
        Rig rig = new Rig(WorkspaceMode.WRITE, true);
        rig.modelSays();
        List<Map<String, Object>> history = List.of(
                Map.of("role", "user", "content", "帮我做一个马里奥小游戏"),
                Map.of("role", "assistant", "content", "完整代码如下：```html\n<canvas id=\"gameCanvas\"></canvas>\n```"));
        CodeWorkspaceAgent.Result r = rig.run("确认创建", history, CODE_MODE);
        assertTrue(r.writeOffered(), "写工具下发了，结果里却说没下发 —— 最终回答会以为它不能写，把整份代码贴出来");
        org.mockito.ArgumentCaptor<List<Map<String, Object>>> msgs = org.mockito.ArgumentCaptor.forClass(List.class);
        org.mockito.ArgumentCaptor<List<Map<String, Object>>> tools = org.mockito.ArgumentCaptor.forClass(List.class);
        verify(rig.provider).callToolTurn(any(), msgs.capture(), tools.capture(), any());
        List<Map<String, Object>> sent = msgs.getValue();
        int codeAt = -1, askAt = -1;
        for (int i = 0; i < sent.size(); i++) {
            String c = String.valueOf(sent.get(i).get("content"));
            if (codeAt < 0 && c.contains("gameCanvas")) codeAt = i;
            if ("user".equals(sent.get(i).get("role")) && c.equals("确认创建")) askAt = i;
        }
        // 按消息在列表里的位置比，不在拼起来的字符串里找 —— 系统提示词里本身就写着「确认创建」
        assertTrue(codeAt > 0, "上一轮助手写的代码没交给工具循环 —— 「确认创建」时它不知道要建什么：" + sent);
        assertTrue(askAt > codeAt, "历史应当在这一句话之前：code@" + codeAt + " ask@" + askAt);
        assertTrue(CodeWorkspaceAgent.offeredToolNames(tools.getValue()).contains("write_workspace_file"),
                "按了「代码」、档位允许写，写工具却没下发");
    }

    @Test
    @DisplayName("历史按预算从新往旧取；最新一条单独超预算时留结尾，旧的放不下就不放")
    void 历史按预算截取() {
        List<Map<String, Object>> h = List.of(
                Map.of("role", "user", "content", "旧".repeat(50)),
                Map.of("role", "assistant", "content", "新".repeat(30)));
        List<Map<String, Object>> fit = CodeWorkspaceAgent.recentHistory(h, 100);
        assertEquals(2, fit.size());
        assertEquals("user", fit.get(0).get("role"), "应当恢复成时间顺序");
        List<Map<String, Object>> tight = CodeWorkspaceAgent.recentHistory(h, 40);
        assertEquals(1, tight.size(), "放不下的旧消息不该塞半截进来");
        List<Map<String, Object>> tiny = CodeWorkspaceAgent.recentHistory(h, 10);
        String kept = String.valueOf(tiny.get(0).get("content"));
        assertTrue(kept.startsWith("…（前面省略）") && kept.endsWith("新"), "单条超预算时应当留结尾：" + kept);
    }

    /** 显式「代码」模式要能一次写出一整个文件：输出上限放大，读超时放长 —— 但不越过剩余预算。 */
    @Test
    @DisplayName("显式代码模式：单次调用 16384 token、读超时远大于 25 秒；关键词触发仍是 4096 / 25 秒")
    void 单次调用限额随模式() throws Exception {
        Rig rig = new Rig(WorkspaceMode.READ, true);
        rig.modelSays();
        rig.run("帮我看看 Main.java 的代码", CODE_MODE);
        org.mockito.ArgumentCaptor<ModelProviderClient.ToolTurnLimits> lim =
                org.mockito.ArgumentCaptor.forClass(ModelProviderClient.ToolTurnLimits.class);
        verify(rig.provider).callToolTurn(any(), any(), any(), lim.capture());
        assertEquals(16384, lim.getValue().maxTokens(), "显式代码模式的输出上限没放大 —— 一整个文件会被截成半截 JSON");
        assertTrue(lim.getValue().readTimeoutMillis() > 60_000, "读超时还是短的：" + lim.getValue());

        Rig kw = new Rig(WorkspaceMode.READ, true);
        kw.modelSays();
        kw.run("帮我看看 Main.java 的代码", Map.of());
        verify(kw.provider).callToolTurn(any(), any(), any(), lim.capture());
        assertEquals(4096, lim.getValue().maxTokens());
        assertTrue(lim.getValue().readTimeoutMillis() <= 25_000, "关键词触发的读超时被放长了：" + lim.getValue());
    }

    @Test
    @DisplayName("单次读超时不越过剩余预算（至少 5 秒）—— 否则循环会跑过整条流的超时")
    void 读超时不越过剩余预算() {
        CodeLoopBudget b = CodeLoopBudget.EXPLICIT;
        assertEquals(150_000, b.turnLimits(0).readTimeoutMillis());
        assertEquals(30_000, b.turnLimits(b.millis() - 30_000).readTimeoutMillis(), "剩 30 秒时却允许等更久");
        assertEquals(5_000, b.turnLimits(b.millis() + 10_000).readTimeoutMillis());
        for (long t = 0; t < b.millis(); t += 7_000) {
            assertTrue(t + b.turnLimits(t).readTimeoutMillis() <= b.millis() + 5_000,
                    "第 " + t + "ms 开始的一轮可以等到预算之外太久");
        }
    }

    /** 循环中断原来只进日志；用户看到的是「卡住了」，然后一段没头没尾的回答。 */
    @Test
    @DisplayName("工具循环中断要发一条 error 叙述，说出原因")
    void 中断要说出来() throws Exception {
        Rig rig = new Rig(WorkspaceMode.READ, true);
        when(rig.provider.callToolTurn(any(), any(), any(), any()))
                .thenThrow(new com.zhiqu.common.BusinessException("工具调用失败：Read timed out"));
        rig.run("帮我看看 Main.java 的代码", CODE_MODE);
        assertTrue(rig.notes.stream().anyMatch(n -> "error".equals(n.get("phase"))
                && String.valueOf(n.get("message")).contains("Read timed out")), "中断没有说出来：" + rig.notes);
    }

    /**
     * 2026-09-24 用户做马里奥：一次工具调用想写完整个文件，输出被截断，截断的回复里没有完整的工具调用，
     * 循环当成「说完了」静默结束 —— 用户看到的就是一直卡在同一步。被截断要说出来、并让模型拆小了再写一轮。
     */
    @Test
    @DisplayName("输出被截断：发一条 budget 叙述，告诉模型拆小文件，循环继续并能写成")
    void 截断不是说完了() throws Exception {
        Rig rig = new Rig(WorkspaceMode.WRITE, true);
        when(rig.workspace.baselineOf("game/index.html")).thenReturn(WorkspaceService.ABSENT);
        when(rig.provider.callToolTurn(any(), any(), any(), any()))
                .thenThrow(new ModelProviderClient.ToolTurnTruncatedException(16384))
                .thenReturn(JSON.readTree(toolCall("write_workspace_file",
                        "{\"path\":\"game/index.html\",\"content\":\"<canvas></canvas>\"}")))
                .thenReturn(JSON.readTree("{\"role\":\"assistant\",\"content\":\"好了\"}"));
        CodeWorkspaceAgent.Result r = rig.run("帮我做一个小游戏，放在 game 文件夹里", CODE_MODE);

        assertTrue(rig.notes.stream().anyMatch(n -> "budget".equals(n.get("phase"))
                && String.valueOf(n.get("message")).contains("截断")), "被截断没有说出来：" + rig.notes);
        assertEquals(1, r.drafts().size(), "截断之后循环没有继续 —— 第二轮本来能写成：" + rig.notes);
        @SuppressWarnings({"unchecked", "rawtypes"})
        org.mockito.ArgumentCaptor<List<Map<String, Object>>> msgs = org.mockito.ArgumentCaptor.forClass((Class) List.class);
        verify(rig.provider, times(3)).callToolTurn(any(), msgs.capture(), any(), any());
        String second = String.valueOf(msgs.getAllValues().get(1));
        assertTrue(second.contains("被截断") && second.contains("拆成"),
                "模型没被告知它被截断了、该怎么改 —— 下一轮它会原样再写一遍、再被截断：" + second);
    }
}
