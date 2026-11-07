package com.zhiqu.service.ai;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessClock;
import com.zhiqu.entity.AiModelConfig;
import com.zhiqu.service.ReminderPlanService;
import com.zhiqu.service.ContextOptionKeys;
import com.zhiqu.service.KnowledgeService;
import com.zhiqu.service.workspace.WorkspaceAccess;
import com.zhiqu.service.workspace.WorkspaceExecutor;
import com.zhiqu.service.workspace.WorkspaceMode;
import com.zhiqu.service.workspace.SingleAccountRegistry;
import com.zhiqu.service.workspace.WorkspaceRegistry;
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
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 代码模式的门和桥（第九十七轮起 {@link CodeWorkspaceAgent} 只剩这两件；循环是命令行那一份，见 {@link JsCodeAgentTest} 和 zhiqu-cli/test/code-host.test.js）。
 *
 * <p>Java 循环那些判据（没下发的工具调不到、没读过不许改、改一段的几种错法、大文件分段读、截断、上下文预算……）删了：
 * 同样的性质由命令行那份的判据管 —— 工具下发清单（code-host.test.js「没有写意图时不下发写工具」）、
 * 没读过不许改 / 读过之后被改过（local-tools.test.js、code-host.test.js 草稿层）、改一段（edit-conformance、local-tools.test.js 第八十六 / 九十二轮那几条）、
 * 分段读与截断（local-tools / odd-files / agent.test.js）。这里管的是：门判得对、判完原样交过去、经桥回来的远程工具。
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
        final List<Map<String, Object>> notes = new ArrayList<>();
        final CodeWorkspaceAgent agent;

        Rig(WorkspaceMode mode) {
            when(workspace.access()).thenReturn(new WorkspaceAccess(mode, root.toString(), "127.0.0.1"));
            when(provider.supportsToolCalling(any())).thenReturn(true);
            WikiToolAgent wiki = new WikiToolAgent(mock(KnowledgeService.class), provider, JSON);
            BusinessClock clock = mock(BusinessClock.class);
            when(clock.today()).thenReturn(LocalDate.of(2026, 9, 23));
            StudyPlanTool plans = new StudyPlanTool(clock, mock(ReminderPlanService.class), JSON);
            agent = new CodeWorkspaceAgent(provider, new SingleAccountRegistry(workspace, executor), wiki, JSON, plans);
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

    @Test
    @DisplayName("这个账号的工作区是 OFF：直接返回空，命令行那份循环连起都不起")
    void 门没过不起循环() {
        Rig rig = new Rig(WorkspaceMode.OFF);
        JsCodeAgent js = mock(JsCodeAgent.class);
        when(js.enabled()).thenReturn(true);
        rig.agent.setJsEngine(js);
        assertSame(CodeWorkspaceAgent.Result.EMPTY, rig.run("帮我看看 Main.java 这段代码", CODE_MODE));
        verify(js, never()).run(any(), any(), any(), any(), anyBoolean(), anyBoolean(), any(), any(), any(), any(), any());
    }

    @Test
    @DisplayName("问的是发消息的这个账号：一个开着 EXEC，另一个关着，同一个后端各走各的")
    void 按账号判() throws Exception {
        WorkspaceService on = mock(WorkspaceService.class);
        WorkspaceService off = mock(WorkspaceService.class);
        WorkspaceExecutor onExec = mock(WorkspaceExecutor.class);
        WorkspaceExecutor offExec = mock(WorkspaceExecutor.class);
        when(on.access()).thenReturn(new WorkspaceAccess(WorkspaceMode.EXEC, root.toString(), "127.0.0.1"));
        when(off.access()).thenReturn(new WorkspaceAccess(WorkspaceMode.OFF, "", "127.0.0.1"));
        when(onExec.enabled()).thenReturn(true);
        WorkspaceRegistry registry = mock(WorkspaceRegistry.class);
        when(registry.service(1L)).thenReturn(on);
        when(registry.service(2L)).thenReturn(off);
        when(registry.executor(1L)).thenReturn(onExec);
        when(registry.executor(2L)).thenReturn(offExec);
        CodeWorkspaceAgent agent = new CodeWorkspaceAgent(mock(ModelProviderClient.class), registry, null, JSON, null);
        assertTrue(agent.readableBy(1L));
        assertFalse(agent.readableBy(2L));
        // 写和执行也问发消息的这个账号：账号 3 只读，账号 1 的 EXEC 不给它
        WorkspaceService readOnly = mock(WorkspaceService.class);
        when(readOnly.access()).thenReturn(new WorkspaceAccess(WorkspaceMode.READ, root.toString(), "127.0.0.1"));
        when(registry.service(3L)).thenReturn(readOnly);
        when(registry.executor(3L)).thenReturn(offExec);
        when(registry.service(1L)).thenReturn(on);
        JsCodeAgent js = mock(JsCodeAgent.class);
        when(js.enabled()).thenReturn(true);
        ModelProviderClient provider = mock(ModelProviderClient.class);
        when(provider.supportsToolCalling(any())).thenReturn(true);
        BusinessClock clock = mock(BusinessClock.class);
        when(clock.today()).thenReturn(LocalDate.of(2026, 9, 23));
        CodeWorkspaceAgent running = new CodeWorkspaceAgent(provider, registry, new WikiToolAgent(mock(KnowledgeService.class), provider, JSON), JSON,
                new StudyPlanTool(clock, mock(ReminderPlanService.class), JSON));
        running.setJsEngine(js);
        running.run(new AiModelConfig(), 3L, "改一下 a.py", List.of(), CODE_MODE, null, m -> { });
        verify(js).run(any(), eq(3L), eq("改一下 a.py"), any(), eq(false), eq(false), any(), any(), any(), any(), any());
        running.run(new AiModelConfig(), 1L, "改一下 a.py", List.of(), CODE_MODE, null, m -> { });
        verify(js).run(any(), eq(1L), eq("改一下 a.py"), any(), eq(true), eq(true), any(), any(), any(), any(), any());
    }

    /**
     * 门的结果原样交给命令行那份循环（第九十七轮）：写意图 + 档位允许写才给写、执行器说能跑才给跑。
     * 交过去之后「给了什么就只下发什么」由宿主管（DraftTools.allowedTools，code-host.test.js 钉着）。
     */
    @Test
    @DisplayName("门的结果原样交过去：只读档 / 没有写意图不给写；执行器不能跑就不给跑；能写能跑都给")
    void 门的结果原样交过去() {
        record Case(WorkspaceMode mode, boolean execEnabled, String message, Map<String, Object> options, boolean write, boolean exec) { }
        for (Case c : List.of(
                new Case(WorkspaceMode.READ, false, "改一下 a.py", CODE_MODE, false, false),
                new Case(WorkspaceMode.WRITE, false, "改一下 a.py", CODE_MODE, true, false),
                new Case(WorkspaceMode.EXEC, true, "改一下 a.py", CODE_MODE, true, true),
                new Case(WorkspaceMode.EXEC, true, "这段代码为什么报错", Map.of(), false, true))) {
            Rig rig = new Rig(c.mode());
            when(rig.executor.enabled()).thenReturn(c.execEnabled());
            JsCodeAgent js = mock(JsCodeAgent.class);
            when(js.enabled()).thenReturn(true);
            when(js.run(any(), any(), any(), any(), anyBoolean(), anyBoolean(), any(), any(), any(), any(), any()))
                    .thenReturn(new CodeWorkspaceAgent.Result("", List.of(), null, c.write(), List.of(), false));
            rig.agent.setJsEngine(js);
            rig.run(c.message(), c.options());
            verify(js).run(any(), eq(1L), eq(c.message()), any(), eq(c.write()), eq(c.exec()), any(), any(), any(), any(), any());
        }
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

    /** 第九十五轮：交给命令行那份循环的远程工具 —— 下发和执行同一份清单，判过题之前的 create_wiki_patch 在执行时也挡 */
    @Test
    @DisplayName("交给命令行那份循环的远程工具：Wiki 读工具一直给、记薄弱点等跑过命令、里程碑只在项目引导时给；没给的照样拒")
    void 交给命令行那份循环的远程工具() {
        Rig rig = new Rig(WorkspaceMode.EXEC);
        CodeWorkspaceAgent.LoopState loop = new CodeWorkspaceAgent.LoopState();
        JsCodeAgent.RemoteTools tools = rig.agent.remoteTools(1L, loop, false);
        Set<String> always = CodeWorkspaceAgent.offeredToolNames(tools.always());
        assertTrue(always.contains("search_wiki") && always.contains("read_wiki_page"), always.toString());
        assertFalse(always.contains("create_wiki_patch") || always.contains(StudyPlanTool.NAME), always.toString());
        assertEquals(Set.of("create_wiki_patch"), CodeWorkspaceAgent.offeredToolNames(tools.afterRun()));
        String early = tools.call("create_wiki_patch", "{\"title\":\"薄弱点：x\",\"content\":\"x\"}", false);
        assertTrue(early.contains("create_wiki_patch") && !early.startsWith("已"), "没判过题就记薄弱点，应当被拒：" + early);
        assertTrue(tools.call(StudyPlanTool.NAME, "{}", true).contains(StudyPlanTool.NAME), "不是项目引导时不给里程碑工具");
        assertTrue(CodeWorkspaceAgent.offeredToolNames(rig.agent.remoteTools(1L, loop, true).always()).contains(StudyPlanTool.NAME));
    }

    /**
     * 两份 coding agent 合成一份，第 1 步（第九十四轮）：开关是 js 时，门（管理员、档位、写意图、能不能执行）照旧在这里判完，
     * 循环交给命令行那一份（JsCodeAgent 起子进程）；它起不来（返回 null）就照旧走 Java 的循环。
     */
    @Test
    @DisplayName("网页选的思考档位交给循环（第一百零八轮）；不说就是 instant —— 工具轮不思考（第五十四轮：一问要等几分钟）")
    void 思考档位交给循环() {
        Rig rig = new Rig(WorkspaceMode.WRITE);
        JsCodeAgent js = mock(JsCodeAgent.class);
        when(js.enabled()).thenReturn(true);
        when(js.run(any(), any(), any(), any(), anyBoolean(), anyBoolean(), any(), any(), any(), any(), any()))
                .thenReturn(new CodeWorkspaceAgent.Result("", List.of(), null, true, List.of(), false));
        rig.agent.setJsEngine(js);
        rig.agent.run(new AiModelConfig(), 1L, "改一下 a.py", List.of(), CODE_MODE, null, "MAX", rig.notes::add);
        verify(js).run(any(), any(), any(), any(), anyBoolean(), anyBoolean(), any(), any(), any(), any(), eq("MAX"));
        rig.run("改一下 a.py", CODE_MODE);
        verify(js).run(any(), any(), any(), any(), anyBoolean(), anyBoolean(), any(), any(), any(), any(), eq("OFF"));
    }

    @Test
    @DisplayName("门判完才交给命令行那一份；不是管理员连起都不起；经桥记下的里程碑交回主流程；起不来（没有 node）说清楚、结果是空的")
    void 交给命令行那一份() throws Exception {
        CodeWorkspaceAgent.Result fromJs = new CodeWorkspaceAgent.Result("【代码 agent 的结论】\n好", List.of(), null, true);
        Rig rig = new Rig(WorkspaceMode.WRITE);
        JsCodeAgent js = mock(JsCodeAgent.class);
        when(js.enabled()).thenReturn(true);
        when(js.run(any(), any(), any(), any(), anyBoolean(), anyBoolean(), any(), any(), any(), any(), any())).thenReturn(fromJs);
        rig.agent.setJsEngine(js);
        CodeWorkspaceAgent.Result viaJs = rig.run("改一下 a.py", CODE_MODE);
        assertEquals(fromJs.context(), viaJs.context());
        verify(js).run(any(), eq(1L), eq("改一下 a.py"), any(), eq(true), eq(false), any(), any(), any(), any(), any());
        verify(rig.provider, never()).callToolTurn(any(), any(), any(), any());

        // 第九十五轮：JS 那份经桥调了「把里程碑排成任务」—— 记在这里的循环状态上，要交回主流程（走 PLANNER 那条确认的路）
        Rig project = new Rig(WorkspaceMode.WRITE);
        JsCodeAgent js3 = mock(JsCodeAgent.class);
        when(js3.enabled()).thenReturn(true);
        when(js3.run(any(), any(), any(), any(), anyBoolean(), anyBoolean(), any(), any(), any(), any(), any())).thenAnswer(inv -> {
            JsCodeAgent.RemoteTools remote = inv.getArgument(9);
            String reply = remote.call(StudyPlanTool.NAME, "{\"tasks\":[{\"title\":\"让蛇动起来\"}]}", false);
            return new CodeWorkspaceAgent.Result("【工作区 create_study_plan】\n" + reply, List.of(), null, true, List.of(), false);
        });
        project.agent.setJsEngine(js3);
        CodeWorkspaceAgent.Result planned = project.run("带我从零做一个贪吃蛇小项目", CODE_MODE);
        assertNotNull(planned.milestonePlan(), "经桥记下的里程碑没交回主流程：" + planned.context());
        assertEquals(1, ((List<?>) planned.milestonePlan().get("tasks")).size());

        // 第九十七轮删了 Java 的循环：js 那份起不来（run 返回 null）、或者根本没有引擎 —— 不再退回，轨迹里说清楚缺 Node，结果是空的
        for (JsCodeAgent broken : java.util.Arrays.asList(mock(JsCodeAgent.class), null)) {
            Rig fallback = new Rig(WorkspaceMode.WRITE);
            if (broken != null) {
                when(broken.enabled()).thenReturn(true);
            }
            fallback.agent.setJsEngine(broken);
            assertSame(CodeWorkspaceAgent.Result.EMPTY, fallback.run("改一下 a.py", CODE_MODE));
            assertTrue(fallback.notes.stream().anyMatch(n -> "error".equals(n.get("phase"))
                    && String.valueOf(n.get("message")).contains("代码模式要用 Node")), "起不来要说清楚：" + fallback.notes);
            verify(fallback.provider, never()).callToolTurn(any(), any(), any(), any());
        }
    }
}
