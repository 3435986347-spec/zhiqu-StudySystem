package com.zhiqu.cli;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * zhiqu 命令行的三个纯部件：SSE 解析、逐行 diff、终端渲染，外加根目录护栏。
 * 都不碰网络 —— 直接喂输入、比对输出。
 */
class CliPartsTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    // ── SSE ──────────────────────────────────────────────────────────────

    private static List<SseParser.Event> parse(String... lines) {
        List<SseParser.Event> got = new ArrayList<>();
        SseParser p = new SseParser(got::add);
        for (String l : lines) p.line(l);
        p.end();
        return got;
    }

    @Test
    @DisplayName("SSE：Spring 的「event:名字」（冒号后无空格）与标准写法都认")
    void sse两种写法() {
        List<SseParser.Event> got = parse("event:message.delta", "data:{\"text\":\"a\"}", "",
                "event: done", "data: {}", "");
        assertEquals(2, got.size());
        assertEquals("message.delta", got.get(0).name());
        assertEquals("{\"text\":\"a\"}", got.get(0).data());
        assertEquals("done", got.get(1).name());
        assertEquals("{}", got.get(1).data());
    }

    @Test
    @DisplayName("SSE：多行 data 用换行拼起来；注释行忽略；CRLF 去掉 \\r")
    void sse多行与注释() {
        List<SseParser.Event> got = parse(": ping", "event:x\r", "data:第一行\r", "data:第二行", "");
        assertEquals(1, got.size());
        assertEquals("x", got.get(0).name());
        assertEquals("第一行\n第二行", got.get(0).data());
    }

    /** 流在最后一个事件后没有空行就断了：那一条往往就是 done，丢了 CLI 会以为没结束。 */
    @Test
    @DisplayName("SSE：最后一条没有空行收尾时，end() 要把它补发出来")
    void sse末尾无空行() {
        List<SseParser.Event> got = parse("event:done", "data:{\"status\":\"DONE\"}");
        assertEquals(1, got.size(), "最后一条事件丢了");
        assertEquals("done", got.get(0).name());
    }

    // ── diff ─────────────────────────────────────────────────────────────

    @Test
    @DisplayName("diff：新建文件全是 +")
    void diff新建() {
        List<String> h = LineDiff.hunks("", "a\nb\n", 3);
        assertEquals(List.of("@@ 第 1 行 @@", "+a", "+b"), h);
    }

    @Test
    @DisplayName("diff：改一行，带上下文，行号指向旧文件")
    void diff改一行() {
        String old = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n";
        String now = "1\n2\n3\n4\n5\nSIX\n7\n8\n9\n10\n";
        List<String> h = LineDiff.hunks(old, now, 2);
        assertEquals(List.of("@@ 第 4 行 @@", " 4", " 5", "-6", "+SIX", " 7", " 8"), h);
    }

    @Test
    @DisplayName("diff：相隔很远的两处改动分成两块；内容相同返回空")
    void diff分块与相同() {
        StringBuilder a = new StringBuilder(), b = new StringBuilder();
        for (int i = 1; i <= 30; i++) {
            a.append(i).append('\n');
            b.append(i == 2 ? "two" : i == 28 ? "twenty-eight" : String.valueOf(i)).append('\n');
        }
        long blocks = LineDiff.hunks(a.toString(), b.toString(), 3).stream().filter(l -> l.startsWith("@@")).count();
        assertEquals(2, blocks, "两处改动相隔 26 行，应该是两块");
        assertTrue(LineDiff.hunks("x\ny\n", "x\ny\n", 3).isEmpty());
    }

    /**
     * 行号要数<b>旧文件</b>的行：新增的行不占旧文件的行号。
     *
     * <p>上一条判据（改一行）区分不出这一点 —— 那一处改动之前没有新增行，两种数法结果一样。
     * 扰动「新增行也计数」时它照样绿，是扰动逮到的（2026-09-23）。这里让前面先插一行，
     * 看后面那一块的标题还对不对。
     */
    @Test
    @DisplayName("diff：前面插入过行之后，后面那一块的行号仍然指向旧文件")
    void diff行号数旧文件() {
        StringBuilder a = new StringBuilder(), b = new StringBuilder();
        for (int i = 1; i <= 30; i++) {
            a.append(i).append('\n');
            if (i == 2) b.append("NEW\n");
            b.append(i == 28 ? "twenty-eight" : String.valueOf(i)).append('\n');
        }
        List<String> h = LineDiff.hunks(a.toString(), b.toString(), 3);
        List<String> heads = h.stream().filter(l -> l.startsWith("@@")).toList();
        assertEquals(List.of("@@ 第 1 行 @@", "@@ 第 25 行 @@"), heads,
                "第二块从旧文件第 25 行开始（28 往前 3 行上下文）；插入的 NEW 不该把它推到 26");
    }

    @Test
    @DisplayName("diff：超预算退回整份新内容，并明说退回了")
    void diff超预算() {
        String big = "x\n".repeat(2100);
        assertNull(LineDiff.diff(big, big + "y\n"));
        List<String> h = LineDiff.hunks(big, big + "y\n", 3);
        assertTrue(h.get(0).contains("不逐行比较"), "超预算没有明说：" + h.get(0));
    }

    // ── 渲染 ─────────────────────────────────────────────────────────────

    private static String render(String[][] events) throws Exception {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        CliRenderer r = new CliRenderer(new PrintStream(buf, true, StandardCharsets.UTF_8), false);
        for (String[] e : events) r.onEvent(e[0], JSON.readTree(e[1]));
        return buf.toString(StandardCharsets.UTF_8);
    }

    /**
     * 这是 CLI 存在的理由之一：coding agent 的每一步都要看得见。
     * 「读取」「生成草稿」「运行」各一行，命令输出缩进显示在运行那一行下面。
     */
    @Test
    @DisplayName("渲染：coding agent 的每一步一行，命令输出缩进在下面")
    void 渲染每一步() throws Exception {
        String out = render(new String[][]{
                {"agent.step.start", "{\"agentRunId\":7,\"publicSummary\":\"正在查看工作区里的代码\"}"},
                {"agent.step.note", "{\"phase\":\"call\",\"tool\":\"read_workspace_file\",\"message\":\"读取 src/Main.java\"}"},
                {"agent.step.note", "{\"phase\":\"call\",\"tool\":\"run_workspace_command\",\"message\":\"运行 python3 test.py\"}"},
                {"agent.step.note", "{\"phase\":\"result\",\"tool\":\"run_workspace_command\",\"message\":\"退出码 1\\nAssertionError\"}"},
                {"message.delta", "{\"text\":\"测试没过，\"}"},
                {"message.delta", "{\"text\":\"原因是……\"}"},
                {"done", "{\"status\":\"DONE\"}"},
        });
        assertTrue(out.contains("· 正在查看工作区里的代码"), out);
        assertTrue(out.contains("  ⎿ 读取 src/Main.java"), out);
        assertTrue(out.contains("  ⎿ 运行 python3 test.py"), out);
        assertTrue(out.contains("    │ 退出码 1\n    │ AssertionError"), "命令输出没有缩进显示：\n" + out);
        assertTrue(out.contains("测试没过，原因是……"), "回答没有连成一段：\n" + out);
        assertTrue(out.indexOf("读取 src/Main.java") < out.indexOf("测试没过"), "步骤应在回答之前");
    }

    @Test
    @DisplayName("渲染：记下 agentRunId 与草稿工件 id，流结束后要靠它们去取 diff")
    void 渲染记下草稿() throws Exception {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        CliRenderer r = new CliRenderer(new PrintStream(buf, true, StandardCharsets.UTF_8), false);
        r.onEvent("agent.run.start", JSON.readTree("{\"agentRunId\":42}"));
        r.onEvent("artifact.created", JSON.readTree("{\"agentRunId\":42,\"artifactId\":9,\"artifactType\":\"CODE_DRAFT\",\"title\":\"代码改动草稿\"}"));
        assertEquals(42L, r.agentRunId());
        assertEquals(List.of(9L), new ArrayList<>(r.artifactIds()));
        assertTrue(buf.toString(StandardCharsets.UTF_8).contains("草稿：代码改动草稿"));
    }

    @Test
    @DisplayName("渲染：error 事件红字显示并记下；关掉颜色时不输出转义序列")
    void 渲染错误() throws Exception {
        String out = render(new String[][]{{"error", "{\"message\":\"模型服务超时\"}"}});
        assertTrue(out.contains("✗ 模型服务超时"), out);
        assertFalse(out.contains("\u001b["), "关了颜色却输出了 ANSI 转义：" + out);
    }

    // ── 根目录护栏 ───────────────────────────────────────────────────────

    @Test
    @DisplayName("护栏：根目录与家目录拒绝当工作区；项目文件夹放行")
    void 根目录护栏() {
        Path home = Path.of("/Users/someone");
        assertNotNull(ZhiquCli.broadRootRefusal(Path.of("/"), home), "根目录没被拒绝");
        assertNotNull(ZhiquCli.broadRootRefusal(home, home), "家目录没被拒绝");
        assertNotNull(ZhiquCli.broadRootRefusal(Path.of("/Users/someone/../someone"), home), "绕一圈回到家目录没被拒绝");
        assertNull(ZhiquCli.broadRootRefusal(Path.of("/Users/someone/Developer/test"), home), "项目文件夹被误拒");
    }

    // ── 参数 ─────────────────────────────────────────────────────────────

    @Test
    @DisplayName("参数：--mode 只收 read/write/exec；不认识的参数报错而不是忽略")
    void 参数() {
        assertEquals("EXEC", ZhiquCli.Options.parse(new String[]{"--mode", "exec"}).mode);
        assertEquals("你好", ZhiquCli.Options.parse(new String[]{"-p", "你好"}).prompt);
        assertThrowsIae(() -> ZhiquCli.Options.parse(new String[]{"--mode", "off"}));
        assertThrowsIae(() -> ZhiquCli.Options.parse(new String[]{"--nope"}));
        assertThrowsIae(() -> ZhiquCli.Options.parse(new String[]{"-p"}));
    }

    private static void assertThrowsIae(Runnable r) {
        try {
            r.run();
        } catch (IllegalArgumentException expected) {
            return;
        }
        throw new AssertionError("应该报参数错误");
    }

    @Test
    @DisplayName("User-Agent 以 ZhiquCLI/ 开头 —— 登录设备列表靠它认出「命令行」")
    void userAgent() {
        assertTrue(ZhiquCli.userAgent().startsWith("ZhiquCLI/"), ZhiquCli.userAgent());
    }

}
