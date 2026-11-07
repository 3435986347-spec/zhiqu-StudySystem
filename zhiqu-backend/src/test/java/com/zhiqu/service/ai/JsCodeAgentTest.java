package com.zhiqu.service.ai;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.NodeRunner;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.AiModelConfig;
import com.zhiqu.service.harness.HarnessModelGateway;
import com.zhiqu.service.workspace.WorkspaceAccess;
import com.zhiqu.service.workspace.WorkspaceExecutor;
import com.zhiqu.service.workspace.SingleAccountRegistry;
import com.zhiqu.service.workspace.WorkspaceRegistry;
import com.zhiqu.service.workspace.WorkspaceProperties;
import com.zhiqu.service.workspace.WorkspaceService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.ObjectProvider;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 两份 coding agent 合成一份，第 1 步（第九十四轮）：后端起 node 跑命令行那一份循环（zhiqu-cli/src/host/code-host.js），一行一个 JSON。
 * 真起 node、真跑命令行的循环；模型（HarnessModelGateway）和命令（WorkspaceExecutor）是假的 —— 看协议两头对不对得上、
 * 草稿照旧不落盘、门照旧在后端；另用一个专门干坏事的假子进程（src/test/resources/js/fake-code-host）看后端拒不拒、丢不丢、停不停。
 */
class JsCodeAgentTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path CLI_DIR = Path.of("../zhiqu-cli").toAbsolutePath().normalize();
    private static final Path FAKE_HOST = Path.of("src/test/resources/js/fake-code-host").toAbsolutePath();

    @TempDir Path root;
    private final WorkspaceService workspace = mock(WorkspaceService.class);
    private final WorkspaceExecutor executor = mock(WorkspaceExecutor.class);
    private final HarnessModelGateway gateway = mock(HarnessModelGateway.class);
    private final List<Map<String, Object>> bodies = new ArrayList<>();
    private final List<Map<String, Object>> notes = new ArrayList<>();
    private final AiModelConfig config = new AiModelConfig();
    private String node;

    @BeforeEach
    void setUp() {
        node = NodeRunner.findNode();
        assumeTrue(node != null || !Boolean.getBoolean("zhiqu.skipNodeTests"), "显式跳过了 node 判据");
        assertNotNull(node, "找不到 node：这几条判据没有跑 —— 这不是通过（-Dzhiqu.nodePath 指过来，或 -Dzhiqu.skipNodeTests=true 写明跳过）");
        WorkspaceAccess access = mock(WorkspaceAccess.class);
        when(access.root()).thenReturn(root);
        when(workspace.access()).thenReturn(access);
        config.setId(42L);
        config.setModelName("deepseek-v4-pro");
        config.setContextWindowTokens(1_000_000);
    }

    @SuppressWarnings("unchecked")
    private JsCodeAgent agent(Path cliDir, List<Map<String, Object>> replies) {
        int[] n = {0};
        doAnswer(inv -> {
            bodies.add(new LinkedHashMap<>((Map<String, Object>) inv.getArgument(1)));
            Map<String, Object> reply = replies.get(Math.min(n[0]++, replies.size() - 1));
            HarnessModelGateway.Sink sink = inv.getArgument(2);
            sink.event("start", Map.of("contextWindow", 1_000_000));
            sink.event("done", reply);
            return null;
        }).when(gateway).stream(eq(7L), any(), any(), eq(false));   // 不记进命令行的用量表（第九十五轮）
        ObjectProvider<HarnessModelGateway> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(gateway);
        return new JsCodeAgent(provider, new SingleAccountRegistry(workspace, executor), new WorkspaceProperties(), JSON, node, cliDir.toString());
    }

    private static Map<String, Object> calls(String... nameAndArgs) {
        List<Map<String, Object>> list = new ArrayList<>();
        for (int i = 0; i < nameAndArgs.length; i += 2) {
            list.add(Map.of("id", "c" + i, "type", "function", "function", Map.of("name", nameAndArgs[i], "arguments", nameAndArgs[i + 1])));
        }
        return Map.of("message", Map.of("role", "assistant", "content", "", "tool_calls", list), "finishReason", "tool_calls", "maxTokens", 16384,
                "usage", Map.of("promptTokens", 100, "completionTokens", 5, "estimated", false));
    }

    private static Map<String, Object> text(String content) {
        return Map.of("message", Map.of("role", "assistant", "content", content), "finishReason", "stop", "maxTokens", 16384,
                "usage", Map.of("promptTokens", 100, "completionTokens", 5, "estimated", false));
    }

    private static String sha256(String s) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));
    }

    @Test
    @DisplayName("文件夹和执行器按账号取：这个账号没选文件夹就起不来，另一个账号选了也不算")
    @SuppressWarnings("unchecked")
    void 按账号取文件夹() throws Exception {
        WorkspaceRegistry registry = mock(WorkspaceRegistry.class);
        WorkspaceService none = mock(WorkspaceService.class);
        WorkspaceAccess noAccess = mock(WorkspaceAccess.class);
        when(noAccess.root()).thenReturn(null);
        when(none.access()).thenReturn(noAccess);
        when(registry.target(7L, null)).thenReturn(new WorkspaceRegistry.CodeTarget(workspace, executor, false));
        when(registry.target(8L, null)).thenReturn(new WorkspaceRegistry.CodeTarget(none, mock(WorkspaceExecutor.class), false));
        ObjectProvider<HarnessModelGateway> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(gateway);
        JsCodeAgent js = new JsCodeAgent(provider, registry, new WorkspaceProperties(), JSON, node, CLI_DIR.toString());
        assertNull(js.run(config, 8L, "看看", List.of(), false, false, CodeLoopBudget.forRequest(true), ContextBudget.DEFAULT, notes::add), "账号 8 没选文件夹");
        doAnswer(inv -> {
            HarnessModelGateway.Sink sink = inv.getArgument(2);
            sink.event("start", Map.of("contextWindow", 1_000_000));
            sink.event("done", text("好了"));
            return null;
        }).when(gateway).stream(eq(7L), any(), any(), eq(false));
        assertNotNull(js.run(config, 7L, "看看", List.of(), false, false, CodeLoopBudget.forRequest(true), ContextBudget.DEFAULT, notes::add), "账号 7 选了");
        verify(registry).target(7L, null);
    }

    @Test
    @DisplayName("真跑命令行那一份：读、改成草稿、跑命令回到后端的执行器；草稿和指纹对、磁盘不动、轨迹一步一句、结论进上下文")
    void 真跑命令行那一份() throws Exception {
        String original = "def add(a, b):\n    return a - b\n";
        Files.writeString(root.resolve("calc.py"), original);
        when(executor.exec(anyString(), any(), anyString())).thenReturn(
                new WorkspaceExecutor.ExecResult("python3", List.of("test_calc.py"), 0, "ok", false, false, 30));
        JsCodeAgent js = agent(CLI_DIR, List.of(
                calls("read_file", "{\"path\":\"calc.py\"}"),
                calls("edit_file", "{\"path\":\"calc.py\",\"old_string\":\"return a - b\",\"new_string\":\"return a + b\"}"),
                calls("run_command", "{\"command\":\"python3\",\"args\":[\"test_calc.py\"]}"),
                text("改动已生成草稿，确认后生效。")));
        assertTrue(js.enabled());
        CodeWorkspaceAgent.Result r = js.run(config, 7L, "修好 add", List.of(Map.of("role", "user", "content", "前一句")),
                true, true, CodeLoopBudget.forRequest(true), ContextBudget.DEFAULT, notes::add);
        assertNotNull(r, "起不来了：" + notes);
        assertEquals(1, r.drafts().size(), "应当有一份草稿：" + r.drafts() + " 轨迹：" + notes);
        Map<String, Object> draft = r.drafts().get(0);
        assertEquals("calc.py", draft.get("path"));
        assertEquals("def add(a, b):\n    return a + b\n", draft.get("content"));
        assertEquals(sha256(original), draft.get("baseline"), "指纹要和 WorkspaceService.baselineOf 同一个算法，确认时才对得上");
        assertEquals(false, draft.get("creating"));
        assertEquals(original, Files.readString(root.resolve("calc.py")), "磁盘一个字都不能动");
        verify(executor).exec("python3", List.of("test_calc.py"), "");
        assertTrue(r.writeOffered());
        assertTrue(r.writeAttempted(), "调过 edit_file：最终回答在没草稿时才能据此说「没写成」");
        assertTrue(r.context().contains("【代码 agent 的结论】\n改动已生成草稿，确认后生效。"), r.context());
        assertTrue(notes.stream().anyMatch(n -> String.valueOf(n.get("message")).contains("修改 calc.py")), "轨迹里要说改了哪个文件：" + notes);
        assertEquals(4, bodies.size());
        assertTrue(bodies.stream().allMatch(b -> Long.valueOf(42L).equals(b.get("modelId"))), "模型由后端定");
    }

    @Test
    @DisplayName("第一百一十八轮：/review 走真的宿主和真的 git：diff 替模型取好，下发的工具没有写的，结论写回给最终回答；/init 发的是命令行那份提示")
    void review和init走宿主() throws Exception {
        git("init", "-q");
        Files.writeString(root.resolve("calc.py"), "def add(a, b):\n    return a + b\n");
        git("add", ".");
        git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "第一版");
        Files.writeString(root.resolve("calc.py"), "def add(a, b):\n    return a - b\n");
        JsCodeAgent review = agent(CLI_DIR, List.of(text("{\"summary\":\"符号反了。\",\"findings\":[{\"priority\":\"P1\",\"file\":\"calc.py\",\"line\":2,"
                + "\"title\":\"加法在减\",\"why\":\"add 在减\",\"fix\":\"改回 +\"}]}")));
        CodeWorkspaceAgent.Result r = review.run(config, 7L, "/review 看看符号", List.of(), false, false, CodeLoopBudget.forRequest(true), ContextBudget.DEFAULT,
                notes::add, null, "OFF", null, "review");
        assertNotNull(r, "起不来了：" + notes);
        assertTrue(r.context().contains("[P1] calc.py:2 加法在减"), r.context());
        assertTrue(r.drafts().isEmpty());
        String sent = String.valueOf(bodies.get(0).get("messages"));
        assertTrue(sent.contains("+    return a - b"), "diff 要替模型取好放进提示：" + sent);
        String tools = String.valueOf(bodies.get(0).get("tools"));
        assertTrue(tools.contains("read_file") && !tools.contains("write_file") && !tools.contains("edit_file"), tools);

        bodies.clear();
        JsCodeAgent init = agent(CLI_DIR, List.of(text("写好了")));
        init.run(config, 7L, "/init", List.of(), true, false, CodeLoopBudget.forRequest(true), ContextBudget.DEFAULT, notes::add, null, "OFF", null, "init");
        String asked = String.valueOf(bodies.get(0).get("messages"));
        assertTrue(asked.contains("写一份 ZHIQU.md 初稿"), asked);
    }

    private void git(String... args) throws Exception {
        List<String> command = new ArrayList<>(List.of("git"));
        command.addAll(List.of(args));
        Process p = new ProcessBuilder(command).directory(root.toFile()).redirectErrorStream(true).start();
        String out = new String(p.getInputStream().readAllBytes());
        assertEquals(0, p.waitFor(), "git 没跑成：" + out);
    }

    @Test
    @DisplayName("思考档位真的到了模型请求（第一百零八轮）：后端的词换成命令行的词；instant 也明说，不落到服务端给命令行的默认档")
    void 思考档位到模型请求() throws Exception {
        JsCodeAgent js = agent(CLI_DIR, List.of(text("结论")));
        js.run(config, 7L, "看看", List.of(), false, false, CodeLoopBudget.forRequest(false), ContextBudget.DEFAULT, notes::add, null, "EXTRA");
        assertEquals("extra", bodies.get(0).get("reasoning"), "选的档位没传到模型请求：" + notes);
        bodies.clear();
        js.run(config, 7L, "看看", List.of(), false, false, CodeLoopBudget.forRequest(false), ContextBudget.DEFAULT, notes::add, null);
        assertEquals("instant", bodies.get(0).get("reasoning"));
    }

    @Test
    @DisplayName("远程工具（第九十五轮）：Wiki 工具经桥交给后端那一套执行；记薄弱点的工具真的跑过一次命令才下发，后端执行时也知道跑没跑过")
    void 远程工具经桥执行() throws Exception {
        Files.writeString(root.resolve("test_q.py"), "print('FAIL')\n");
        when(executor.exec(anyString(), any(), anyString())).thenReturn(
                new WorkspaceExecutor.ExecResult("python3", List.of("test_q.py"), 1, "FAIL", false, false, 9));
        List<String> called = new ArrayList<>();
        Map<String, Object> search = Map.of("type", "function", "function", Map.of("name", "search_wiki", "description", "搜", "parameters", Map.of("type", "object")));
        Map<String, Object> patch = Map.of("type", "function", "function", Map.of("name", "create_wiki_patch", "description", "记", "parameters", Map.of("type", "object")));
        JsCodeAgent.RemoteTools remote = new JsCodeAgent.RemoteTools() {
            public List<Map<String, Object>> always() { return List.of(search); }
            public List<Map<String, Object>> afterRun() { return List.of(patch); }
            public String call(String name, String argsJson, boolean ranCommand) {
                called.add(name + ":" + ranCommand + ":" + argsJson);
                return "后端执行了 " + name;
            }
        };
        JsCodeAgent js = agent(CLI_DIR, List.of(
                calls("search_wiki", "{\"query\":\"薄弱点\"}"),
                calls("run_command", "{\"command\":\"python3\",\"args\":[\"test_q.py\"]}"),
                calls("create_wiki_patch", "{\"title\":\"薄弱点：两数之和\"}"),
                text("记下来了。")));
        CodeWorkspaceAgent.Result r = js.run(config, 7L, "出题考我", List.of(), true, true, CodeLoopBudget.forRequest(true), ContextBudget.DEFAULT,
                notes::add, remote);
        assertNotNull(r);
        assertEquals(List.of("search_wiki:false:{\"query\":\"薄弱点\"}", "create_wiki_patch:true:{\"title\":\"薄弱点：两数之和\"}"), called);
        java.util.function.Function<Integer, List<String>> offered = i -> ((List<Map<String, Object>>) bodies.get(i).get("tools")).stream()
                .map(t -> String.valueOf(((Map<?, ?>) t.get("function")).get("name"))).toList();
        assertTrue(offered.apply(0).contains("search_wiki") && !offered.apply(0).contains("create_wiki_patch"), offered.apply(0).toString());
        assertTrue(offered.apply(2).contains("create_wiki_patch"), "跑过命令之后才给：" + offered.apply(2));
        assertTrue(r.context().contains("后端执行了 create_wiki_patch"), r.context());
    }

    @Test
    @DisplayName("门在后端：子进程自己填的模型不认；不能执行时硬发 exec 回拒绝、执行器碰都不碰；跳出工作区的草稿路径丢掉")
    void 门在后端() throws Exception {
        doThrow(new BusinessException("路径超出工作区范围")).when(workspace).checkWritable("../evil.txt");
        JsCodeAgent js = agent(FAKE_HOST, List.of(text("好")));
        CodeWorkspaceAgent.Result r = js.run(config, 7L, "abuse", List.of(), true, false,
                CodeLoopBudget.forRequest(true), ContextBudget.DEFAULT, notes::add);
        assertNotNull(r);
        assertEquals(42L, bodies.get(0).get("modelId"), "子进程填的 999 不认");
        verify(executor, never()).exec(anyString(), any(), anyString());
        assertTrue(r.context().contains("这一次不能跑命令"), r.context());
        // 没给 shell 时硬发 shell（第一百零九轮）：同样在这里挡住，碰都不碰执行器
        CodeWorkspaceAgent.Result shell = agent(FAKE_HOST, List.of(text("好"))).run(config, 7L, "abuse-shell", List.of(), true, true,
                CodeLoopBudget.forRequest(true), ContextBudget.DEFAULT, notes::add);
        assertTrue(shell.context().contains("这一次不能跑命令"), shell.context());
        verify(executor, never()).shell(any(), any(), org.mockito.ArgumentMatchers.anyBoolean(), any(), org.mockito.ArgumentMatchers.anyLong());
        verify(executor, never()).startShell(any(), any(), org.mockito.ArgumentMatchers.anyBoolean(), any());
        assertEquals(List.of("ok.txt"), r.drafts().stream().map(d -> d.get("path")).toList(), "跳出工作区的那份要丢掉");
    }

    /** node 在真正空的环境下自己就有的变量（macOS 会给每个进程加 __CF_USER_TEXT_ENCODING）—— 判据的地板，现场量，不手写名单 */
    private java.util.Set<String> nodeFloor() throws Exception {
        String bin = new JsCodeAgent(null, new SingleAccountRegistry(workspace, executor), new WorkspaceProperties(), JSON, node, CLI_DIR.toString()).nodeBinary();
        ProcessBuilder pb = new ProcessBuilder(bin, "-e", "console.log(Object.keys(process.env).sort().join(','))");
        pb.environment().clear();
        Process p = pb.start();
        String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
        p.waitFor();
        return out.isEmpty() ? java.util.Set.of() : java.util.Set.of(out.split(","));
    }

    @Test
    @DisplayName("子进程只看得到 HOME 和 PATH（不继承环境变量：主进程里有 AI 密钥和数据库密码）；认不出的消息就停，不猜")
    void 环境变量与认不出的消息() throws Exception {
        JsCodeAgent js = agent(FAKE_HOST, List.of(text("好")));
        CodeWorkspaceAgent.Result r = js.run(config, 7L, "env", List.of(), false, false,
                CodeLoopBudget.forRequest(true), ContextBudget.DEFAULT, notes::add);
        assertNotNull(r);
        String env = notes.stream().map(n -> String.valueOf(n.get("message"))).filter(m -> m.contains("PATH")).findFirst().orElse("");
        java.util.Set<String> floor = nodeFloor();
        List<String> extra = java.util.Arrays.stream(env.split(",")).filter(k -> !floor.contains(k)).sorted().toList();
        assertEquals(List.of("HOME", "PATH"), extra, "子进程的环境变量（node 自己的地板 " + floor + " 之外）：" + notes);
        assertTrue(System.getenv().size() > 5, "父进程只有 " + System.getenv().size() + " 个环境变量 —— 判据没有可比对的样本");
        assertEquals("", r.context());
        assertTrue(r.drafts().isEmpty());
    }

    /** 第九十六轮：桌面应用、网页服务器部署旁边没有 zhiqu-cli 目录 —— 用 JAR 里带的那一份（pom 的 bundle-zhiqu-cli） */
    @Test
    @DisplayName("找不到 zhiqu-cli 目录：用 JAR 里带的那一份（解到临时目录），照样跑得起来，而且和源码一字不差（不会带着旧代码出去）")
    void 用JAR里带的那一份() throws Exception {
        Files.writeString(root.resolve("a.txt"), "hello\n");
        JsCodeAgent js = agent(root.resolve("没有这个目录"), List.of(calls("read_file", "{\"path\":\"a.txt\"}"), text("里面是 hello")));
        assertTrue(js.enabled());
        Path script = js.hostScript();
        assertFalse(script.startsWith(CLI_DIR), "应当是解出来的那一份：" + script);
        Path bundled = script.getParent().getParent().getParent();
        try (var files = Files.walk(CLI_DIR.resolve("src"))) {
            List<Path> sources = files.filter(Files::isRegularFile).toList();
            assertTrue(sources.size() > 20, "源码太少，扫描没扫到东西：" + sources.size());
            for (Path f : sources) {
                Path copy = bundled.resolve(CLI_DIR.relativize(f).toString());
                assertTrue(Files.exists(copy) && java.util.Arrays.equals(Files.readAllBytes(f), Files.readAllBytes(copy)),
                        "JAR 里带的和源码不一样（或者没带）：" + CLI_DIR.relativize(f));
            }
        }
        CodeWorkspaceAgent.Result r = js.run(config, 7L, "a.txt 里是什么", List.of(), false, false,
                CodeLoopBudget.forRequest(true), ContextBudget.DEFAULT, notes::add);
        assertNotNull(r);
        assertTrue(r.context().contains("里面是 hello"), r.context() + " 轨迹：" + notes);
    }

    @Test
    @DisplayName("找不到 zhiqu-cli 目录：用 JAR 里带的（第九十六轮）；找不到 node：返回 null（调用方在轨迹里说清楚，第九十七轮起没有 Java 的循环可退）")
    void 起不来就退回() {
        ObjectProvider<HarnessModelGateway> provider = mock(ObjectProvider.class);
        assertTrue(new JsCodeAgent(provider, new SingleAccountRegistry(workspace, executor), new WorkspaceProperties(), JSON, node, root.toString()).enabled(),
                "配的目录里没有脚本：用 JAR 里带的那一份");
        // cli-dir 没配：按工作目录找（Maven 在 zhiqu-backend 里跑，旁边就是 zhiqu-cli）
        assertTrue(new JsCodeAgent(provider, new SingleAccountRegistry(workspace, executor), new WorkspaceProperties(), JSON, node, "").enabled(),
                "cli-dir 留空时应当按工作目录找到 zhiqu-cli（user.dir=" + System.getProperty("user.dir") + "）");
        JsCodeAgent noNode = new JsCodeAgent(provider, new SingleAccountRegistry(workspace, executor), new WorkspaceProperties(), JSON, "/nonexistent/node", CLI_DIR.toString());
        assertTrue(noNode.enabled());
        assertNull(noNode.run(config, 7L, "x", List.of(), false, false, CodeLoopBudget.forRequest(true), ContextBudget.DEFAULT, notes::add));
    }

    /** 第九十九轮 review：子进程不交结果就退 —— 原来轨迹里什么都不说、stderr 跟着临时目录一起删掉 */
    @Test
    @DisplayName("子进程没交回结果：轨迹里说清楚，stderr 的末尾记进日志（stderrTail 读得到、超长只留末尾）")
    void 没交回结果() throws Exception {
        JsCodeAgent js = agent(FAKE_HOST, List.of(text("好")));
        CodeWorkspaceAgent.Result r = js.run(config, 7L, "crash", List.of(), false, false,
                CodeLoopBudget.forRequest(true), ContextBudget.DEFAULT, notes::add);
        assertNotNull(r);
        assertEquals("", r.context());
        assertTrue(notes.stream().anyMatch(n -> "error".equals(n.get("phase")) && String.valueOf(n.get("message")).contains("没交回结果")), notes.toString());
        Path log = root.resolve("stderr.log");
        Files.writeString(log, "x".repeat(3000) + "最后一行");
        String tail = JsCodeAgent.stderrTail(log);
        assertTrue(tail.endsWith("最后一行") && tail.length() <= 2001, tail.length() + "");
        assertEquals("", JsCodeAgent.stderrTail(root.resolve("没有这个文件")));
    }
}
