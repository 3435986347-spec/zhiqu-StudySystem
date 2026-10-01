package com.zhiqu.desktop;

import com.zhiqu.SourceText;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * 桌面外壳里的页面能选文件、能下载（{@code deploy/desktop/macos-shell/PageView.swift}，2026-10-01）。
 *
 * <p>WKWebView 不实现代理方法就不做这些事，<b>而且不报错</b>：用户报「Wiki 导入来源 → 上传文件解析，点了没反应」——
 * 文件选择面板根本不出来，WebKit 直接当成取消（AI 助手上传资料、换头像同样）；页面的导出 / 下载原件则把整个应用窗口
 * 导航成那份文件的原文，无边框窗口没有后退。两样都是在真的 WKWebView 里实测的。
 *
 * <p>这里把 PageView.swift 和一个检查程序一起编译，在真的 WKWebView 里真点 file input、真点 a[download]、
 * 真走外部链接 —— 只有面板换成不开窗口的桩。只在 macOS 上有意义；没有 swiftc 明确失败，
 * 要跳过写明 {@code -Dzhiqu.skipSwiftTests=true}（和 {@link DesktopCdsCacheTest} 同一个约定）。
 */
class DesktopPageViewTest {

    private static final Path SHELL = Path.of("../deploy/desktop/macos-shell");

    @TempDir
    Path tmp;

    @Test
    @DisplayName("文件选择：面板出来、单选 / 多选照 input 的设置、选中的文件真到了页面上、取消时页面收到 cancel")
    void 文件选择() throws Exception {
        Map<String, String> out = runCheck();
        assertEquals("false", out.get("one.multiple"), "单选的 input 面板没出来（panel-not-shown = WebKit 当成了取消），或者被配成了多选");
        assertEquals("one:change:1:笔记 A.txt:内容甲", out.get("one.result"), "选中的文件没有到页面上");
        assertEquals("true", out.get("many.multiple"), "multiple 的 input 面板不许多选");
        assertEquals("many:change:2:笔记 A.txt|b.md:内容甲", out.get("many.result"));
        assertEquals("one:cancel", out.get("cancel.result"), "在面板里取消，页面应当收到 cancel");
    }

    @Test
    @DisplayName("下载：存到选的位置、窗口不导航到 blob；已存在的文件按替换处理；在保存面板里取消不算失败、写不进去要说；外部链接交给系统浏览器")
    void 下载与外部链接() throws Exception {
        Map<String, String> out = runCheck();
        assertEquals("true", out.get("download.saved"), "a[download] 的内容没存下来");
        assertEquals("知识库.zip", out.get("download.suggested"), "保存面板里的默认文件名应当是页面给的那个");
        assertEquals("true", out.get("download.stayed"), "下载时整个窗口被导航走了 —— 应用里只剩文件原文、没有后退");
        assertEquals("true", out.get("replace.saved"), "存到已存在的文件上失败了（WKDownload 不肯覆盖，要先删）");
        assertEquals("0", out.get("replace.failures"));
        assertEquals("true", out.get("saveCancel.nothingWritten"));
        assertEquals("0", out.get("saveCancel.failures"), "用户在保存面板里点取消，被当成失败弹了提示");
        assertEquals("true", out.get("saveCancel.stayed"));
        assertEquals("1", out.get("writeFail.reported"), "写不进去（只读文件夹）的下载一声不吭 —— WebKit 报的是「已取消」，按取消滤掉就成了这样");
        assertEquals("true", out.get("writeFail.namesPlace"), "写不进去时要说出是哪儿（WebKit 给的说明是空的）");
        assertEquals("https://example.com/x", out.get("external.opened"), "外部链接没交给系统浏览器");
        assertEquals("true", out.get("external.stayed"), "外部链接在应用窗口里打开了");
    }

    @Test
    @DisplayName("外壳用的就是 PageView：不另设代理（uiDelegate 是 weak 的，另设一个当场就被释放）")
    void 外壳接上的是PageView() throws Exception {
        String shell = SourceText.stripComments(Files.readString(SHELL.resolve("ZhiquShell.swift"), StandardCharsets.UTF_8));
        assertTrue(shell.contains("webView = PageView(frame:"), "ZhiquShell.swift 没有用 PageView 建页面");
        assertFalse(shell.contains(".uiDelegate =") || shell.contains(".navigationDelegate ="),
                "ZhiquShell.swift 另设了代理 —— 会顶掉 PageView 自己的文件选择 / 下载处理");
        assertFalse(shell.contains("WKWebView("), "ZhiquShell.swift 里另建了一个裸的 WKWebView");
        String script = Files.readString(Path.of("../deploy/desktop/package-macos-native.sh"), StandardCharsets.UTF_8);
        assertTrue(script.contains("macos-shell/PageView.swift\""), "打包脚本没把 PageView.swift 编进外壳");
    }

    /** 编译并跑一次检查程序。 */
    private Map<String, String> runCheck() throws Exception {
        Assumptions.assumeTrue(System.getProperty("os.name", "").toLowerCase().contains("mac"), "外壳只在 macOS 上编译");
        Assumptions.assumeFalse(Boolean.getBoolean("zhiqu.skipSwiftTests"), "按 -Dzhiqu.skipSwiftTests=true 跳过");
        if (!new File("/usr/bin/swiftc").canExecute()) {
            fail("这台 Mac 上没有 swiftc（装 Xcode 命令行工具：xcode-select --install），外壳的文件选择 / 下载验不了；"
                    + "确实要跳过就加 -Dzhiqu.skipSwiftTests=true");
        }
        Path src = Files.createDirectories(tmp.resolve("src"));
        Files.copy(Path.of("src/test/resources/swift/page-view-check.swift"), src.resolve("main.swift"));
        Files.copy(SHELL.resolve("PageView.swift"), src.resolve("PageView.swift"));
        Path bin = tmp.resolve("check");
        run(600, "/usr/bin/swiftc", "-O", "-framework", "AppKit", "-framework", "WebKit", "-o", bin.toString(),
                src.resolve("main.swift").toString(), src.resolve("PageView.swift").toString());
        Path work = Files.createDirectories(tmp.resolve("work"));
        String text = run(90, bin.toString(), work.toString());
        Map<String, String> map = new HashMap<>();
        for (String line : text.split("\n")) {
            int eq = line.indexOf('=');
            if (eq > 0) map.put(line.substring(0, eq), line.substring(eq + 1));
        }
        assertEquals("true", map.get("done"), "检查程序没有走完：\n" + text);
        return map;
    }

    private static String run(int timeoutSeconds, String... cmd) throws Exception {
        // 输出写文件、等进程本身（不读到 EOF）：WebKit 的子进程可能晚一点才关掉继承的管道
        Path log = Files.createTempFile("page-view-check", ".log");
        try {
            Process p = new ProcessBuilder(cmd).redirectErrorStream(true).redirectOutput(log.toFile()).start();
            p.getOutputStream().close();
            if (!p.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
                p.destroyForcibly();
                fail("超时：" + String.join(" ", cmd) + "\n" + Files.readString(log));
            }
            String out = Files.readString(log, StandardCharsets.UTF_8);
            assertEquals(0, p.exitValue(), () -> String.join(" ", cmd) + " 失败：\n" + out);
            return out;
        } finally {
            Files.deleteIfExists(log);
        }
    }
}
