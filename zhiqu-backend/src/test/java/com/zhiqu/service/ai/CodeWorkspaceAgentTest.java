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
            var stub = when(provider.callOpenAiToolTurn(any(), any(), any()));
            for (String r : replies) {
                stub = stub.thenReturn(JSON.readTree(r));
            }
            stub.thenReturn(JSON.readTree("{\"role\":\"assistant\",\"content\":\"好了\"}"));
        }

        CodeWorkspaceAgent.Result run(String message, Map<String, Object> options) {
            return agent.run(new AiModelConfig(), 1L, message, options, notes::add);
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
        verify(rig.provider, never()).callOpenAiToolTurn(any(), any(), any());
    }

    @Test
    @DisplayName("工作区是 OFF：同样直接返回空")
    void 工作区关着不碰模型() {
        Rig rig = new Rig(WorkspaceMode.OFF, true);
        assertSame(CodeWorkspaceAgent.Result.EMPTY, rig.run("帮我看看 Main.java 这段代码", CODE_MODE));
        verify(rig.provider, never()).callOpenAiToolTurn(any(), any(), any());
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
        verify(rig.provider, times(2)).callOpenAiToolTurn(any(), any(), any());
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

}
