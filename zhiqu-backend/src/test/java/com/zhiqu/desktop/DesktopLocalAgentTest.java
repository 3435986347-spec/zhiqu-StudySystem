package com.zhiqu.desktop;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import com.zhiqu.NodeRunner;
import com.zhiqu.SourceText;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * 桌面版本机代码助手（第一百二十九轮，docs/desktop-remote-plan.md 第 2 步）：外壳（{@code LocalAgent.swift} + {@code PageView.swift} 的 zqLocal 桥）
 * 按需起 node 跑命令行的宿主。这里把外壳源码和一个检查程序一起编译，真起 node、真跑 {@code zhiqu-cli/src/host/code-host.js}、真沙箱，
 * 模型网关是这里起的假的（照 {@code HarnessController} 的回包：{@code {code, data}}、SSE 的 start / done）。选文件夹的系统框换成不开面板的桩。
 * 只在 macOS 上有意义；没有 swiftc / node 明确失败，要跳过写 {@code -Dzhiqu.skipSwiftTests=true}。
 */
class DesktopLocalAgentTest {

    private static final Path SHELL = Path.of("../deploy/desktop/macos-shell");
    private static final String TOKEN = "zqp_localAgentCheck_0123456789abcdefXYZ";
    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir
    Path tmp;

    private HttpServer server;
    private final CountDownLatch release = new CountDownLatch(1);
    /** 网关收到的每一个请求：方法、路径、Authorization 头、正文 */
    private final List<String[]> seen = new CopyOnWriteArrayList<>();

    @AfterEach
    void stop() {
        release.countDown();
        if (server != null) server.stop(0);
    }

    @Test
    @DisplayName("本机代码助手：外壳起 node 跑宿主走完一轮（模型走网关、令牌只在请求头里、写只成草稿、读不到家目录）；叫停后进程没了；"
            + "宿主没交结果就退照实说；桥只认主框架、没选过的文件夹不跑、服务器地址不听页面的、迷你窗没有")
    void 本机代码助手() throws Exception {
        Map<String, String> r = runCheck();
        for (String k : r.keySet()) assertFalse(k.startsWith("timeout."), "检查程序有一步没等到：" + k + "\n" + r);
        String gatewayUrl = "http://127.0.0.1:" + server.getAddress().getPort();

        // 一、一轮从起到交 result
        assertEquals("true", r.get("a.available"));
        assertEquals("HOME,LANG,PATH,TMPDIR", r.get("a.envKeys"), "宿主继承了外壳的环境变量");
        assertEquals("ok", r.get("a.started"));
        assertEquals(gatewayUrl, r.get("a.payloadServer"), "交给宿主的服务器不是外壳自己的那个");
        assertEquals("A 做完了", r.get("a.conclusion"), r.toString());
        assertEquals("none", r.get("a.error"));
        assertEquals("new.txt", r.get("a.drafts"), "写文件没成草稿");
        assertEquals("false", r.get("a.diskNew"), "本机代码助手直接写了用户的磁盘（要先成草稿）");
        assertEquals("false", r.get("a.tokenLeak"), "令牌出现在交给页面的消息里");
        assertEquals("0", r.get("a.exit"));
        assertEquals("false", r.get("a.runningAfter"));
        assertTrue(r.get("a.types").contains("trace") && r.get("a.types").endsWith("result,exit"), "消息没按顺序转给页面：" + r.get("a.types"));
        List<String[]> streams = seen.stream().filter(s -> s[1].startsWith("/api/harness/model/stream")).toList();
        assertTrue(streams.size() >= 4, "网关收到的模型调用太少：" + streams.size());
        for (String[] s : seen) {
            if (s[1].equals("/__never__")) continue;
            assertEquals("Bearer " + TOKEN, s[2], s[0] + " " + s[1] + " 没带令牌");
            assertFalse(s[3].contains(TOKEN), s[1] + " 的正文里带了令牌");
        }
        String afterShell = streams.stream().map(s -> s[3]).filter(b -> b.contains("A-RUN") && b.contains("rc=")).findFirst().orElse("");
        assertTrue(!afterShell.isEmpty(), "第二次模型调用里没有命令的结果（命令没跑？）");
        assertFalse(afterShell.contains("HOME-SECRET"), "沙箱里读到了家目录");

        // 二、叫停
        assertTrue(r.get("b.busy").contains("还没完"), "跑着的时候又起了一轮：" + r.get("b.busy"));
        assertEquals("true", r.get("b.stopped"), r.toString());
        assertTrue(r.get("b.conclusion").contains("被你停下了"), r.get("b.conclusion"));
        assertEquals("true", r.get("b.processGone"), "叫停之后宿主进程还在");
        // 先说 stop、宿主自己收尾：一两秒以内。靠 5 秒后的 SIGTERM 才停下的话这里就红（stop 那一行没起作用）
        assertTrue(Double.parseDouble(r.get("b.seconds")) < 4, "叫停太慢（stop 没起作用、等到了 SIGTERM？）：" + r.get("b.seconds"));

        // 三、宿主没交 result 就退
        assertTrue(r.get("c.fatal").contains("退出码 3") && r.get("c.fatal").contains("boom"), "没照实说：" + r.get("c.fatal"));
        assertEquals("false", r.get("c.tokenLeak"), "宿主 stderr 里的令牌原样交给了页面：" + r.get("c.fatal"));

        // 四、包里缺东西
        assertEquals("false", r.get("d.available"));
        assertTrue(r.get("d.start").contains("缺"), r.get("d.start"));

        // 五、桥
        assertTrue(r.get("bridge.frame").startsWith("frame:err") && r.get("bridge.frame").contains("不认"), "页面里嵌的框也能叫外壳：" + r.get("bridge.frame"));
        assertEquals("0", r.get("bridge.framePicks"), "框里叫出了选文件夹的框");
        assertTrue(r.get("bridge.status").startsWith("status:ok") && r.get("bridge.status").contains("\"available\":true")
                && r.get("bridge.status").contains("\"folders\":[]"), r.get("bridge.status"));
        assertTrue(r.get("bridge.notPicked").startsWith("notPicked:err") && r.get("bridge.notPicked").contains("选过"), "没选过的文件夹也跑了：" + r.get("bridge.notPicked"));
        assertTrue(r.get("bridge.pickHome").startsWith("pickHome:err") && r.get("bridge.pickHome").contains("家目录"), "整个家目录当成了项目文件夹：" + r.get("bridge.pickHome"));
        assertTrue(r.get("bridge.pickCancel").contains("\"cancelled\":true"), r.get("bridge.pickCancel"));
        String projReal = tmp.resolve("work/proj").toRealPath().toString();
        assertTrue(r.get("bridge.pick").startsWith("pick:ok") && r.get("bridge.pick").replace("\\/", "/").contains("\"folder\":\"" + projReal + "\""),
                "选好的文件夹要按真实路径回给页面：" + r.get("bridge.pick") + " ≠ " + projReal);
        assertEquals(projReal, r.get("bridge.folders"), "选好的文件夹没记下（或者把家目录也记下了）");
        assertEquals("true", r.get("pick.panel"), "选文件夹的框能选文件");
        assertTrue(r.get("bridge.off").startsWith("off:err") && r.get("bridge.off").contains("档位"), r.get("bridge.off"));
        assertTrue(r.get("bridge.badToken").startsWith("badToken:err") && r.get("bridge.badToken").contains("令牌"), r.get("bridge.badToken"));
        assertTrue(r.get("bridge.run").startsWith("run:ok") && r.get("bridge.run").contains("local-1"), r.get("bridge.run"));
        assertTrue(r.get("bridge.result").contains("桥那边好了"), "桥那一轮的结果没到页面：" + r.get("bridge.result"));
        assertEquals("false", r.get("bridge.eventLeak"));
        assertEquals("local-1", r.get("bridge.runIds"));
        assertTrue(r.get("bridge.applyEscape").startsWith("applyEscape:err") && r.get("bridge.applyEscape").contains("不能写"),
                "路径能写出项目文件夹：" + r.get("bridge.applyEscape"));
        assertTrue(r.get("bridge.applyLink").startsWith("applyLink:err"), "软链指到外面也能写：" + r.get("bridge.applyLink"));
        assertEquals("false", r.get("bridge.applyLinkDisk"), "软链外面出现了文件");
        assertTrue(r.get("bridge.applyStale").startsWith("applyStale:err") && r.get("bridge.applyStale").contains("不一样"),
                "基线不符也写了：" + r.get("bridge.applyStale"));
        assertEquals("hello-project\n", r.get("bridge.applyStaleDisk").replace("\\n", "\n"), "基线不符时磁盘被改了");
        assertTrue(r.get("bridge.applyOk").startsWith("applyOk:ok"), r.get("bridge.applyOk"));
        assertEquals("next\n", r.get("bridge.applyOkDisk").replace("\\n", "\n"), "确认后没写进选过的文件夹");
        assertTrue(r.get("bridge.applyAgain").startsWith("applyAgain:ok"), "已经写过再确认一次不该失败：" + r.get("bridge.applyAgain"));
        assertTrue(r.get("bridge.read").contains("next"), "读不到刚写的文件：" + r.get("bridge.read"));
        assertTrue(r.get("bridge.readOut").startsWith("readOut:err"), "顺着软链读到了外面：" + r.get("bridge.readOut"));
        assertTrue(r.get("bridge.applyOther").startsWith("applyOther:err") && r.get("bridge.applyOther").contains("选过"),
                "没选过的文件夹也能写：" + r.get("bridge.applyOther"));
        assertTrue(seen.stream().anyMatch(s -> s[1].startsWith("/api/harness/model/stream") && s[3].contains("BRIDGE")),
                "桥那一轮没到外壳自己的网关（页面塞的 http://127.0.0.1:1 被用上了？）");
        assertTrue(r.get("bridge.mini").startsWith("mini:err") && r.get("bridge.mini").contains("没有本机代码助手"), "迷你窗也接了本机代码：" + r.get("bridge.mini"));
    }

    @Test
    @DisplayName("外壳接上本机代码助手：主窗口设 localAgent（迷你窗不设）、包里的 node 和宿主、服务器用 Server.url、退出时 SIGTERM；打包脚本带上命令行源码、编进 LocalAgent.swift")
    void 外壳接上() throws IOException {
        String shell = SourceText.stripComments(Files.readString(SHELL.resolve("ZhiquShell.swift"), StandardCharsets.UTF_8));
        assertTrue(shell.contains("webView.localAgent = LocalAgent.bundled(server: Server.url)"), "主窗口没接本机代码助手，或者服务器不是 Server.url");
        assertEquals(1, shell.split("localAgent =", -1).length - 1, "本机代码助手只给主窗口（迷你窗不接）");
        assertTrue(shell.contains("webView?.localAgent?.terminate()") && shell.contains("applicationWillTerminate"), "退出时没收掉本机代码助手");
        assertTrue(shell.contains("ignoreBrokenPipe()"), "宿主先退了时写管子的 SIGPIPE 会把应用带走");
        String agent = SourceText.stripComments(Files.readString(SHELL.resolve("LocalAgent.swift"), StandardCharsets.UTF_8));
        assertTrue(agent.contains("\"node/bin/node\"") && agent.contains("\"zhiqu-cli/src/host/code-host.js\""), "包里的位置对不上");
        String script = Files.readString(Path.of("../deploy/desktop/package-macos-native.sh"), StandardCharsets.UTF_8);
        assertTrue(script.contains("cp -R \"$ROOT/zhiqu-cli/src\" \"$APP/Contents/Resources/zhiqu-cli/src\""), "打包脚本没带上命令行源码");
        assertTrue(script.contains("cp \"$ROOT/zhiqu-cli/package.json\" \"$APP/Contents/Resources/zhiqu-cli/package.json\""),
                "没带 package.json：宿主是 ES 模块（type: module），少了它 node 不认 import");
        assertTrue(script.contains("macos-shell/LocalAgent.swift\""), "打包脚本没把 LocalAgent.swift 编进外壳");
    }

    private Map<String, String> runCheck() throws Exception {
        Assumptions.assumeTrue(System.getProperty("os.name", "").toLowerCase().contains("mac"), "外壳只在 macOS 上编译");
        Assumptions.assumeFalse(Boolean.getBoolean("zhiqu.skipSwiftTests"), "按 -Dzhiqu.skipSwiftTests=true 跳过");
        if (!new File("/usr/bin/swiftc").canExecute()) {
            fail("这台 Mac 上没有 swiftc（xcode-select --install），本机代码助手验不了；确实要跳过就加 -Dzhiqu.skipSwiftTests=true");
        }
        String node = absoluteNode();
        startGateway();
        Path src = Files.createDirectories(tmp.resolve("src"));
        Files.copy(Path.of("src/test/resources/swift/local-agent-check.swift"), src.resolve("main.swift"));
        for (String f : new String[]{"LocalAgent.swift", "PageView.swift", "Server.swift", "MiniPanel.swift"}) {
            Files.copy(SHELL.resolve(f), src.resolve(f));
        }
        Path bin = tmp.resolve("check");
        DesktopPageViewTest.run(600, "/usr/bin/swiftc", "-O", "-framework", "AppKit", "-framework", "WebKit", "-framework", "UserNotifications",
                "-o", bin.toString(), src.resolve("main.swift").toString(), src.resolve("LocalAgent.swift").toString(),
                src.resolve("PageView.swift").toString(), src.resolve("Server.swift").toString(), src.resolve("MiniPanel.swift").toString());
        Path work = Files.createDirectories(tmp.resolve("work"));
        Path host = Path.of("../zhiqu-cli/src/host/code-host.js").toRealPath();
        String text = DesktopPageViewTest.run(150, bin.toString(), work.toString(), node, host.toString(),
                "http://127.0.0.1:" + server.getAddress().getPort(), TOKEN);
        Map<String, String> map = new HashMap<>();
        for (String line : text.split("\n")) {
            int eq = line.indexOf('=');
            if (eq > 0) map.put(line.substring(0, eq), line.substring(eq + 1));
        }
        assertEquals("true", map.get("done"), "检查程序没有走完：\n" + text);
        return map;
    }

    /** LocalAgent 要绝对路径（Process 的 executableURL）；NodeRunner 找到的可能只是 PATH 上的 "node" */
    private static String absoluteNode() {
        String node = NodeRunner.findNode();
        if (node == null) fail("找不到 node（本机代码助手的宿主要它跑）；用 -Dzhiqu.nodePath=<绝对路径> 指位置");
        if (node.contains("/")) return Path.of(node).toAbsolutePath().toString();
        for (String dir : System.getenv().getOrDefault("PATH", "").split(File.pathSeparator)) {
            File f = new File(dir, node);
            if (f.canExecute()) return f.getAbsolutePath();
        }
        fail("PATH 上的 node 找不到绝对路径");
        return null;
    }

    /** 假网关：照 HarnessController 的回包。模型按用户那句话里的记号回：A-RUN 一轮三步、HANG 一直不回、BRIDGE 一句话 */
    private void startGateway() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(Executors.newCachedThreadPool());
        server.createContext("/", this::handle);
        server.start();
    }

    private void handle(HttpExchange ex) throws IOException {
        String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        String path = ex.getRequestURI().getPath();
        String auth = ex.getRequestHeaders().getFirst("Authorization");
        seen.add(new String[]{ex.getRequestMethod(), path, auth == null ? "" : auth, body});
        if (!("Bearer " + TOKEN).equals(auth)) {
            reply(ex, 401, "application/json", "{\"code\":401,\"message\":\"未登录\"}");
            return;
        }
        switch (path) {
            case "/api/harness/models" -> reply(ex, 200, "application/json",
                    "{\"code\":200,\"data\":{\"models\":[{\"id\":7,\"label\":\"m\",\"modelName\":\"m\",\"toolCalling\":true,\"effectiveContextWindow\":100000}],\"defaultModelId\":7}}");
            case "/api/harness/tools" -> reply(ex, 200, "application/json", "{\"code\":200,\"data\":[]}");
            case "/api/harness/model/stream" -> stream(ex, body);
            default -> reply(ex, 404, "application/json", "{\"code\":404}");
        }
    }

    private void stream(HttpExchange ex, String body) throws IOException {
        JsonNode req = JSON.readTree(body);
        int round = 0;
        for (JsonNode m : req.path("messages")) if ("tool".equals(m.path("role").asText())) round++;
        String home = tmp.resolve("work/home").toString();
        String reply;
        if (body.contains("HANG")) {
            ex.getResponseHeaders().set("Content-Type", "text/event-stream");
            ex.sendResponseHeaders(200, 0);
            ex.getResponseBody().flush();
            try {
                release.await(60, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            ex.close();
            return;
        } else if (body.contains("A-RUN") && round == 0) {
            reply = call("shell", Map.of("command", "cat " + home + "/secret.txt; echo rc=$?"));
        } else if (body.contains("A-RUN") && round == 1) {
            reply = call("write_file", Map.of("path", "new.txt", "content", "draft-content\n"));
        } else if (body.contains("A-RUN")) {
            reply = text("A 做完了");
        } else {
            reply = text("桥那边好了");
        }
        String start = "event:start\ndata:{\"contextWindow\":100000,\"droppedMessages\":0,\"elidedToolOutputs\":0}\n\n";
        reply(ex, 200, "text/event-stream", start + "event:done\ndata:" + reply + "\n\n");
    }

    private static String call(String name, Map<String, Object> args) throws IOException {
        Map<String, Object> fn = Map.of("name", name, "arguments", JSON.writeValueAsString(args));
        Map<String, Object> message = Map.of("role", "assistant", "content", "", "tool_calls", List.of(Map.of("id", "c" + name, "type", "function", "function", fn)));
        return JSON.writeValueAsString(Map.of("message", message, "finishReason", "tool_calls", "maxTokens", 16000,
                "usage", Map.of("promptTokens", 100, "completionTokens", 7, "cachedTokens", 0, "estimated", false)));
    }

    private static String text(String content) throws IOException {
        return JSON.writeValueAsString(Map.of("message", Map.of("role", "assistant", "content", content), "finishReason", "stop", "maxTokens", 16000,
                "usage", Map.of("promptTokens", 100, "completionTokens", 7, "cachedTokens", 0, "estimated", false)));
    }

    private static void reply(HttpExchange ex, int status, String type, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", type);
        ex.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(bytes);
        }
    }
}
