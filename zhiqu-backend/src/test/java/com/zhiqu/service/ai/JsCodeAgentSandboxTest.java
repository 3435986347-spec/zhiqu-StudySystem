package com.zhiqu.service.ai;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import com.zhiqu.NodeRunner;
import com.zhiqu.entity.AiModelConfig;
import com.zhiqu.service.harness.HarnessModelGateway;
import com.zhiqu.service.workspace.WorkspaceExecutor;
import com.zhiqu.service.workspace.WorkspaceProperties;
import com.zhiqu.service.workspace.WorkspaceService;
import com.zhiqu.service.workspace.WorkspaceSettingsStore;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.ObjectProvider;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 网页代码模式的系统沙箱（第一百零九轮，用户：「网页代码模式也要给系统沙箱，两者要一致」）。
 * 真起 node、真跑命令行那一份循环、真的 WorkspaceExecutor、真的系统沙箱，只有模型是假的。断言落在磁盘上和命令的输出里。
 * 沙箱的边界本身在 zhiqu-cli/test/sandbox.test.js；这里看后端按档位接得对不对。
 */
class JsCodeAgentSandboxTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path CLI_DIR = Path.of("../zhiqu-cli").toAbsolutePath().normalize();
    private static final Path FAKE_HOST = Path.of("src/test/resources/js/fake-code-host").toAbsolutePath();

    @TempDir Path rootTemp;
    @TempDir Path homeTemp;
    private Path root;
    private Path home;
    private String node;
    private final HarnessModelGateway gateway = mock(HarnessModelGateway.class);
    private final List<Map<String, Object>> bodies = new ArrayList<>();
    private final List<Map<String, Object>> notes = new ArrayList<>();
    private final AiModelConfig config = new AiModelConfig();

    @BeforeEach
    void setUp() throws Exception {
        node = NodeRunner.findNode();
        assumeTrue(node != null || !Boolean.getBoolean("zhiqu.skipNodeTests"), "显式跳过了 node 判据");
        assertNotNull(node, "找不到 node：这几条判据没有跑 —— 这不是通过");
        root = rootTemp.toRealPath();
        home = homeTemp.toRealPath();
        Files.createDirectories(home.resolve(".ssh"));
        Files.writeString(home.resolve(".ssh/id_rsa"), "SECRET-KEY");
        Files.writeString(root.resolve("a.txt"), "原文\n");
        config.setId(42L);
        config.setModelName("deepseek-v4-pro");
        config.setContextWindowTokens(1_000_000);
    }

    private String network = "off";

    private JsCodeAgent agent(String mode, String profile, Path cliDir, List<Map<String, Object>> replies) {
        WorkspaceProperties props = new WorkspaceProperties();
        props.setSandboxNetwork(network);
        props.setMode(mode);
        props.setRoot(root.toString());
        WorkspaceService service = new WorkspaceService(props, new WorkspaceSettingsStore(home.resolve("state-" + bodies.size() + ".json").toString(), JSON), "127.0.0.1");
        WorkspaceExecutor executor = new WorkspaceExecutor(props, service, profile);
        int[] n = {0};
        doAnswer(inv -> {
            @SuppressWarnings("unchecked")
            Map<String, Object> body = (Map<String, Object>) inv.getArgument(1);
            bodies.add(new LinkedHashMap<>(body));
            HarnessModelGateway.Sink sink = inv.getArgument(2);
            sink.event("start", Map.of("contextWindow", 1_000_000));
            sink.event("done", replies.get(Math.min(n[0]++, replies.size() - 1)));
            return null;
        }).when(gateway).stream(eq(7L), any(), any(), eq(false));
        @SuppressWarnings("unchecked")
        ObjectProvider<HarnessModelGateway> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(gateway);
        JsCodeAgent js = new JsCodeAgent(provider, service, executor, props, JSON, node, cliDir.toString());
        js.useSandboxHome(home.toString());
        return js;
    }

    /** 跳过要写明：macOS 一定有 sandbox-exec，探测说没有是探测坏了，不能和通过长得一样。别的平台、写了 -Dzhiqu.skipSandboxTests=true 才跳 */
    private void needSandbox(JsCodeAgent js) throws Exception {
        boolean available = js.sandboxAvailable(js.nodeBinary(), js.hostScript());
        if (System.getProperty("os.name", "").toLowerCase().contains("mac") && !Boolean.getBoolean("zhiqu.skipSandboxTests")) {
            assertTrue(available, "macOS 上探测不到系统沙箱：检查 sandbox-launch.js / detectSandbox（真跑在另一层沙箱里写 -Dzhiqu.skipSandboxTests=true）");
        }
        assumeTrue(available, "这台机器没有系统沙箱：这几条判据没有跑");
    }

    private CodeWorkspaceAgent.Result run(JsCodeAgent js, boolean canWrite, boolean canExec) {
        CodeWorkspaceAgent.Result r = js.run(config, 7L, "干活", List.of(), canWrite, canExec, CodeLoopBudget.forRequest(true), ContextBudget.DEFAULT, notes::add);
        assertNotNull(r, "起不来了：" + notes);
        return r;
    }

    private static Map<String, Object> shell(String command) throws Exception {
        String args = JSON.writeValueAsString(Map.of("command", command));
        return Map.of("message", Map.of("role", "assistant", "content", "", "tool_calls",
                        List.of(Map.of("id", "c1", "type", "function", "function", Map.of("name", "shell", "arguments", args)))),
                "finishReason", "tool_calls", "maxTokens", 16384, "usage", Map.of("promptTokens", 100, "completionTokens", 5, "estimated", false));
    }

    private static Map<String, Object> text(String content) {
        return Map.of("message", Map.of("role", "assistant", "content", content), "finishReason", "stop", "maxTokens", 16384,
                "usage", Map.of("promptTokens", 100, "completionTokens", 5, "estimated", false));
    }

    @SuppressWarnings("unchecked")
    private List<String> toolsOffered() {
        List<Map<String, Object>> tools = (List<Map<String, Object>>) bodies.get(0).get("tools");
        return tools.stream().map(t -> String.valueOf(((Map<String, Object>) t.get("function")).get("name"))).toList();
    }

    /** 第二次请模型时，历史里的工具结果 */
    @SuppressWarnings("unchecked")
    private String toolOutput() {
        List<Map<String, Object>> messages = (List<Map<String, Object>>) bodies.get(bodies.size() - 1).get("messages");
        StringBuilder out = new StringBuilder();
        for (Map<String, Object> m : messages) {
            if ("tool".equals(m.get("role"))) {
                out.append(m.get("content")).append('\n');
            }
        }
        return out.toString();
    }

    @Test
    @DisplayName("auto 档（用户定的「和命令行完全一样」）：给 shell 不给 run_command，直接写得了工作区；写不出去、读不到家目录")
    void auto档() throws Exception {
        Path outside = home.resolve("escaped.txt");
        // 假家目录下的工具链读得到、旁边的凭据读不到：证明后端把「真家目录」传给了沙箱实现
        Files.createDirectories(home.resolve(".m2/repository"));
        Files.writeString(home.resolve(".m2/repository/dep.txt"), "依赖缓存");
        Files.writeString(home.resolve(".m2/settings.xml"), "SECRET-MAVEN");
        JsCodeAgent js = agent("EXEC", "", CLI_DIR, List.of(
                shell("echo 写了 > b.txt; cat b.txt | tr -d x; echo y > " + outside + "; cat " + home.resolve(".ssh/id_rsa")
                        + "; cat " + home.resolve(".m2/repository/dep.txt") + "; cat " + home.resolve(".m2/settings.xml") + "; echo done"),
                text("好了")));
        needSandbox(js);
        CodeWorkspaceAgent.Result r = run(js, true, true);
        assertTrue(toolsOffered().contains("shell"), toolsOffered().toString());
        assertFalse(toolsOffered().contains("run_command"), "下发的和能执行的要同一份");
        assertEquals("写了\n", Files.readString(root.resolve("b.txt")), "auto 档 shell 直接落盘：" + notes);
        String out = toolOutput();
        assertTrue(out.contains("done"), out);
        assertFalse(Files.exists(outside), "写到工作区外了");
        assertFalse(out.contains("SECRET"), "读到家目录的密钥了：" + out);
        assertTrue(out.contains("依赖缓存"), "家目录下的依赖缓存要读得到：" + out);
        assertTrue(r.drafts().isEmpty(), "shell 写的不经过草稿");
    }

    @Test
    @DisplayName("后台进程随命令结束，输出不丢，和命令行一样（网页原来把它留在外面接着跑）")
    void 后台进程() throws Exception {
        JsCodeAgent js = agent("EXEC", "", CLI_DIR, List.of(shell("sleep 25 & echo $! > pid; echo started-bg"), text("好了")));
        needSandbox(js);
        long t0 = System.currentTimeMillis();
        run(js, true, true);
        assertTrue(System.currentTimeMillis() - t0 < 8000, "跟着等了后台进程");
        assertTrue(toolOutput().contains("started-bg"), "输出丢了：" + toolOutput());
        long pid = Long.parseLong(Files.readString(root.resolve("pid")).trim());
        boolean alive = true;
        for (int i = 0; alive && i < 40; i++) {
            alive = ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false);
            if (alive) {
                Thread.sleep(50);
            }
        }
        assertFalse(alive, "后台进程还活着");
    }

    @Test
    @DisplayName("断网：本机的服务也连不上（本机的数据库、Docker 都在本机）；认不出的配置按断网算；管理员配了 local 才连得上（和命令行一个意思）")
    void 断网() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", ex -> {
            byte[] b = "CONNECTED".getBytes(StandardCharsets.UTF_8);
            ex.sendResponseHeaders(200, b.length);
            ex.getResponseBody().write(b);
            ex.close();
        });
        server.start();
        try {
            String curl = "curl -s -m 5 http://127.0.0.1:" + server.getAddress().getPort() + "/; echo \"curl=$?\"";
            for (String value : List.of("off", "乱写的")) {
                bodies.clear();
                network = value;
                JsCodeAgent js = agent("EXEC", "", CLI_DIR, List.of(shell(curl), text("好了")));
                needSandbox(js);
                run(js, true, true);
                String out = toolOutput();
                assertTrue(out.contains("curl="), out);
                assertFalse(out.contains("CONNECTED"), value + "：连上本机的服务了：" + out);
            }
            bodies.clear();
            network = "local";
            JsCodeAgent open = agent("EXEC", "", CLI_DIR, List.of(shell(curl), text("好了")));
            run(open, true, true);
            assertTrue(toolOutput().contains("CONNECTED"), "配了 local 要连得上（对照）：" + toolOutput());
        } finally {
            server.stop(0);
        }
    }

    @Test
    @DisplayName("plan 档也给 shell，沙箱是只读的：读得到，一个字都写不了；manual 档、auto 档没有写意图时同样只读")
    void 只读的档() throws Exception {
        record Case(String mode, boolean canWrite, boolean canExec) { }
        for (Case c : List.of(new Case("READ", false, false), new Case("WRITE", true, false), new Case("EXEC", false, true))) {
            bodies.clear();
            JsCodeAgent js = agent(c.mode(), "", CLI_DIR, List.of(shell("cat a.txt; echo 改了 > a.txt; echo x > c.txt; echo done"), text("好了")));
            needSandbox(js);
            run(js, c.canWrite(), c.canExec());
            assertTrue(toolsOffered().contains("shell"), c.mode() + " 档要给只读的 shell：" + toolsOffered());
            String out = toolOutput();
            assertTrue(out.contains("原文") && out.contains("done"), c.mode() + "：" + out);
            assertEquals("原文\n", Files.readString(root.resolve("a.txt")), c.mode() + " 档把工作区改了");
            assertFalse(Files.exists(root.resolve("c.txt")), c.mode() + " 档在工作区建了文件");
        }
    }

    @Test
    @DisplayName("生产 profile：没有 shell，子进程硬发也跑不了（生产一律不执行，这条不能绕）")
    void 生产不给() throws Exception {
        JsCodeAgent js = agent("EXEC", "prod", CLI_DIR, List.of(text("好了")));
        run(js, true, false);
        assertFalse(toolsOffered().contains("shell"), toolsOffered().toString());
        CodeWorkspaceAgent.Result hard = agent("EXEC", "prod", FAKE_HOST, List.of(text("好"))).run(config, 7L, "abuse-shell", List.of(), true, false,
                CodeLoopBudget.forRequest(true), ContextBudget.DEFAULT, notes::add);
        assertNotNull(hard);
        assertTrue(hard.context().contains("这一次不能跑命令"), hard.context());
        assertFalse(Files.exists(root.resolve("pwned.txt")));
    }

    @Test
    @DisplayName("下发的和能执行的同一份清单：给了 shell，子进程硬发白名单命令回拒绝；循环里模型调 run_command 也不执行")
    void 硬发不在清单里的() throws Exception {
        JsCodeAgent fake = agent("EXEC", "", FAKE_HOST, List.of(text("好")));
        fake.assumeSandbox(true);
        CodeWorkspaceAgent.Result hard = fake.run(config, 7L, "abuse", List.of(), true, true,
                CodeLoopBudget.forRequest(true), ContextBudget.DEFAULT, notes::add);
        assertNotNull(hard);
        assertTrue(hard.context().contains("这一次不能跑命令"), "给了 shell 还接白名单命令：" + hard.context());

        bodies.clear();
        JsCodeAgent loop = agent("EXEC", "", CLI_DIR, List.of(
                Map.of("message", Map.of("role", "assistant", "content", "", "tool_calls",
                                List.of(Map.of("id", "c1", "type", "function", "function", Map.of("name", "run_command", "arguments", "{\"command\":\"node\",\"args\":[\"-v\"]}")))),
                        "finishReason", "tool_calls", "maxTokens", 16384, "usage", Map.of("promptTokens", 100, "completionTokens", 5, "estimated", false)),
                text("好了")));
        needSandbox(loop);
        run(loop, true, true);
        assertFalse(toolOutput().contains("退出码"), "run_command 不在清单里却跑了：" + toolOutput());
    }

    @Test
    @DisplayName("拿不到沙箱就不跑：探测算没有；探测说有、真跑时沙箱脚本没了，整条命令不跑，绝不退回不带沙箱地跑")
    void 拿不到沙箱不跑() throws Exception {
        JsCodeAgent js = agent("EXEC", "", FAKE_HOST, List.of(text("好")));
        assertFalse(js.sandboxAvailable(js.nodeBinary(), js.hostScript()), "这份假宿主旁边没有沙箱脚本：要算没有");
        // 探测说没有：不给 shell，硬发也挡在门口（不是跑到一半才发现沙箱起不来）
        CodeWorkspaceAgent.Result noBox = agent("EXEC", "", FAKE_HOST, List.of(text("好"))).run(config, 7L, "abuse-shell", List.of(), true, true,
                CodeLoopBudget.forRequest(true), ContextBudget.DEFAULT, notes::add);
        assertTrue(noBox.context().contains("这一次不能跑命令"), "探测说没有，还是给了 shell：" + noBox.context());
        JsCodeAgent stale = agent("EXEC", "", FAKE_HOST, List.of(text("好")));
        stale.assumeSandbox(true);
        CodeWorkspaceAgent.Result r = stale.run(config, 7L, "abuse-shell", List.of(), true, true,
                CodeLoopBudget.forRequest(true), ContextBudget.DEFAULT, notes::add);
        assertNotNull(r);
        assertTrue(r.context().contains("系统沙箱起不来"), r.context());
        assertFalse(Files.exists(root.resolve("pwned.txt")), "沙箱起不来还是跑了");
    }

    @Test
    @DisplayName("命令看不到后端的环境变量（AI 密钥、数据库密码都在那里）：只有沙箱实现给的那几个")
    void 环境干净() throws Exception {
        JsCodeAgent js = agent("EXEC", "", CLI_DIR, List.of(shell("env | cut -d= -f1"), text("好了")));
        needSandbox(js);
        run(js, true, true);
        List<String> names = List.of(toolOutput().split("\n"));
        assertTrue(names.contains("TMPDIR"), "对照：要看得到沙箱实现给的：" + names);
        java.util.Set<String> mayAppear = java.util.Set.of("PATH", "HOME", "LANG", "PWD", "SHLVL", "_", "OLDPWD", "TERM", "TMPDIR", "JAVA_HOME", "LC_ALL",
                "VIRTUAL_ENV", "CONDA_PREFIX", "GOROOT", "GOPATH", "GOMODCACHE", "CARGO_HOME", "RUSTUP_HOME", "PYENV_ROOT", "NVM_DIR", "SDKROOT", "DEVELOPER_DIR");
        int checked = 0;
        for (String key : System.getenv().keySet()) {
            if (!mayAppear.contains(key)) {
                checked++;
                assertFalse(names.contains(key), "继承了后端的环境变量 " + key);
            }
        }
        assertTrue(checked > 0, "后端的环境里没有别的变量：这条什么都没看");
        // 发给沙箱脚本的也只有这些：AI 密钥、数据库密码不进它的 stdin
        Map<String, String> sent = JsCodeAgent.toolEnv(js.nodeBinary());
        assertTrue(sent.containsKey("PATH"));
        assertTrue(mayAppear.containsAll(sent.keySet()), "发给沙箱脚本的环境多了：" + sent.keySet());
    }
}
