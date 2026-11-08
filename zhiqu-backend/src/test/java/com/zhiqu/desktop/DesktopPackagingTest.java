package com.zhiqu.desktop;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 钉住打包脚本里那几个「看起来可有可无、删了要到运行时才炸」的开关。
 *
 * <p>2026-09-22 退掉了 macOS 的 jpackage 版打包脚本（它双击后弹系统浏览器，已被原生外壳
 * 取代），随之退掉那条「jpackage 版必须关 headless」—— 同一条知识由
 * {@link #Windows脚本要关headless()} 继续钉着，{@code package-windows.ps1} 也走 jpackage。
 *
 * <p>第一百二十五轮：macOS 外壳改成打开网站（docs/desktop-remote-plan.md），包里不再带 Java 后端和 JRE ——
 * 钉 jlink 模块（jdk.charsets / jdk.crypto.ec）、外壳里 JVM 要 headless、端口文件属性、CDS 启动加速的几条随之去掉
 * （它们钉的东西不在了；jdk.charsets 那段经过留在 docs/notes/desktop.md），换成「包里不带 Java」和外壳打开的是哪个网站。
 *
 * <p>这一类东西不在 Java 代码里，所以平时的判据一条都覆盖不到它们；而它们出问题的方式
 * 有个共同点：<b>报错完全指不到真正的原因</b>，且只在打包后的产物里复现，开发机上永远正常。
 */
class DesktopPackagingTest {

    private static final Path NATIVE_SCRIPT = Path.of("..", "deploy", "desktop", "package-macos-native.sh");
    private static final Path SHELL_DIR = Path.of("..", "deploy", "desktop", "macos-shell");

    /**
     * 外壳不起 Java 之后，包里的 JRE 和 JAR 就是死的：几十 MB、每次打包多跑一遍 Maven 和 jlink，而且让人以为桌面版还有一个本机后端。
     * 外壳里也不许再有起 JVM 的那一套（-jar、包里的 runtime、固定端口 47615）。
     */
    @Test
    @DisplayName("macOS 包里不带 Java：脚本不打 JAR、不跑 jlink、不放 runtime；外壳不起 JVM、不开本机端口；CdsCache.swift 已删")
    void 包里不带Java() throws IOException {
        String script = read(NATIVE_SCRIPT);
        assertTrue(script.contains("hdiutil create"), "扫到的不是打包脚本 —— 空扫会假绿");
        for (String gone : new String[]{"mvn ", "jlink", "JAVA_HOME", "Resources/app", "Resources/runtime", "-Djarmode", ".jar"}) {
            assertFalse(script.contains(gone), "打包脚本里还有 Java 后端的那一套：" + gone);
        }
        String shell = read(SHELL_DIR.resolve("ZhiquShell.swift"));
        assertTrue(shell.contains("webView = PageView(frame:"), "扫到的不是外壳源码 —— 空扫会假绿");
        for (String gone : new String[]{"\"-jar\"", "runtime/Contents/Home", "47615", "Process()", "java"}) {
            assertFalse(shell.contains(gone), "外壳里还在起 Java 后端：" + gone);
        }
        assertFalse(Files.exists(SHELL_DIR.resolve("CdsCache.swift")), "CdsCache.swift（给包里的 JVM 做启动加速）还在");
    }

    /** 外壳打开的是网站：地址只有 Server.swift 一个出处，两个页面（主窗口、迷你窗）都从它取、都只认它的主机 */
    @Test
    @DisplayName("外壳打开 Server.page(...)：主窗口和迷你窗都只认服务器那一个主机、主窗口接上载入结果；打包脚本编进 Server.swift")
    void 外壳打开网站() throws IOException {
        String script = read(NATIVE_SCRIPT);
        assertTrue(script.contains("macos-shell/Server.swift\""), "打包脚本没把 Server.swift 编进外壳");
        String shell = read(SHELL_DIR.resolve("ZhiquShell.swift"));
        String launch = shell.substring(shell.indexOf("func applicationDidFinishLaunching"), shell.indexOf("private func openHome()"));
        String home = shell.substring(shell.indexOf("private func openHome()"), shell.indexOf("private func makeWindow()"));
        assertTrue(launch.contains("openHome()") && home.contains("webView.load(URLRequest(url: Server.page(\"dashboard.html\")))"),
                "启动时打开的不是服务器上的看板：\n" + launch);
        assertTrue(shell.contains("page.load(URLRequest(url: Server.page(\"mini.html\")))"), "迷你窗打开的不是服务器上的 mini.html");
        assertTrue(shell.contains("webView.allowedHosts = [Server.url.host ?? \"\"]"),
                "主窗口还在按本机认「自己的网站」：服务器上的页面一点站内链接就跳到系统浏览器，桥也收不到它的消息");
        assertTrue(shell.contains("page.allowedHosts = [Server.url.host ?? \"\"]"), "迷你窗还在按本机认「自己的网站」：胶囊上的按钮发不出消息");
        assertTrue(shell.contains("webView.onLoad = { [weak self] error in self?.loaded(error) }"),
                "主窗口没接载入结果：连不上服务器时「正在连接」一直挂着，也不说怎么重来");
        assertFalse(shell.contains("http://") || shell.contains("https://"), "外壳里另写了一个地址 —— 地址只在 Server.swift");
        String loaded = shell.substring(shell.indexOf("private func loaded(_ error: Error?)"), shell.indexOf("@objc func reload(_ sender: Any?)"));
        assertTrue(loaded.contains("loadingLabel.isHidden = true") && loaded.contains("fail(") && loaded.contains("⌘R"),
                "载入结果没用上：成功时要收起「正在连接」，失败时要说清楚、告诉人按 ⌘R 重来：\n" + loaded);
    }

    /** 第一百二十六轮：用户在真窗口里停了验证站、按 ⌘R，窗口照样是旧页面、不说连不上 —— 页面装的 Service Worker 拿缓存顶上了 */
    @Test
    @DisplayName("外壳启动先 clearOfflineCache 再打开首页；没载入成时页面藏起来、只剩说明，载入成了再露出来")
    void 启动先清离线缓存() throws IOException {
        String shell = com.zhiqu.SourceText.stripComments(read(SHELL_DIR.resolve("ZhiquShell.swift")));
        String launch = shell.substring(shell.indexOf("func applicationDidFinishLaunching"), shell.indexOf("private func openHome()"));
        assertTrue(launch.contains("clearOfflineCache(webView.configuration.websiteDataStore) { [weak self] in self?.openHome() }"),
                "启动时没先清掉以前装上的 Service Worker（或者清完之前就打开了首页）：断网时它拿缓存的页面顶上，外壳不说连不上：\n" + launch);
        assertEquals(1, launch.split("openHome\\(\\)", -1).length - 1, "启动时 openHome() 只该在清完之后调一次：\n" + launch);
        String loaded = shell.substring(shell.indexOf("private func loaded(_ error: Error?)"), shell.indexOf("@objc func reload(_ sender: Any?)"));
        int ok = loaded.indexOf("webView.isHidden = false");
        int hide = loaded.indexOf("webView.isHidden = true");
        int fail = loaded.indexOf("fail(");
        assertTrue(ok >= 0 && ok < loaded.indexOf("return"), "载入成了没把页面露出来（上一次没连上时藏起来的）：\n" + loaded);
        assertTrue(hide > ok && hide < fail, "没载入成时页面没藏起来：说明压在一个点什么都没反应的旧页面上：\n" + loaded);
    }

    /**
     * 读文件并<b>剥掉注释</b>。
     *
     * <p>这一步不是讲究，是这批判据第一次扰动时五条里有四条假绿的原因：
     * 我在脚本和外壳里为 {@code jdk.charsets} / {@code zhiqu.desktop.port-file}
     * 各写了一段解释，于是把真正的那行代码删掉之后，{@code contains} 仍然被注释满足。
     * {@code contains} 分不清「代码在做这件事」和「文字提到了这件事」。
     *
     * <p>Shell 的 {@code #} 只剥整行注释（行尾 {@code #} 可能在字符串里，剥了会改变语义）；
     * Swift 的 {@code //} 同理。这两个脚本里没有行尾注释，所以够用。
     */
    @Test
    @DisplayName("Windows 打包脚本也要关 headless —— 否则任务栏图标 / 窗口出不来")
    void Windows脚本要关headless() throws IOException {
        String ps1 = read(Path.of("..", "deploy", "desktop", "package-windows.ps1"));
        assertTrue(ps1.contains("jpackage"), "扫到的不是 Windows 打包脚本 —— 空扫会假绿");
        assertTrue(ps1.contains("-Djava.awt.headless=false"),
                "package-windows.ps1 没关 headless。和 macOS jpackage 版同一个坑：headless 的 "
                        + "JVM 不连桌面环境，Windows 上任务栏图标 / 窗口行为会不对。");
    }

    @Test
    @DisplayName("桌面 profile（Windows 版还在用）必须用固定端口 —— 随机端口会让「记住登录」每次失效")
    void 桌面必须固定端口() throws IOException {
        String yml = Files.readString(
                Path.of("..", "zhiqu-backend", "src", "main", "resources", "application-desktop.yml"),
                java.nio.charset.StandardCharsets.UTF_8);
        java.util.regex.Matcher m =
                java.util.regex.Pattern.compile("(?m)^\\s*port:\\s*(\\d+)").matcher(yml);
        assertTrue(m.find(), "application-desktop.yml 里找不到 server.port —— 判据扫空了");
        int port = Integer.parseInt(m.group(1));
        assertTrue(port > 0,
                "桌面 profile 的 server.port 是 " + port + "（0 = 随机端口）。localStorage 按 origin"
                        + "（含端口）隔离，端口每次随机的话，上次记住的登录 token 这次读不到 —— "
                        + "「记住登录」永远失效。必须固定。");

    }

    // ── 命令行 ────────────────────────────────────────────────────────

    /**
     * 应用包里不再带 Java 版命令行（2026-10-04 删除，由 npm 版 zhiqu 接替）。脚本里留着拷它的那几行的话，
     * 打包直接失败（源文件没了）；留着空的 Resources/bin 则是一个指向不存在东西的入口。
     */
    @Test
    @DisplayName("应用包不带 Java 版命令行：不拷 bin/zhiqu、不建 Resources/bin，仓库里也没有它")
    void 不再打包Java版命令行() throws IOException {
        String script = read(NATIVE_SCRIPT);
        assertTrue(script.contains("mkdir -p \"$APP/Contents/MacOS\" \"$APP/Contents/Resources\""), "扫到的不是打包脚本 —— 空扫会假绿");
        assertFalse(script.contains("bin/zhiqu") || script.contains("Resources/bin"), "打包脚本还在拷 Java 版 zhiqu");
        assertFalse(Files.exists(Path.of("..", "deploy", "desktop", "bin", "zhiqu")), "deploy/desktop/bin/zhiqu 还在");
        assertFalse(Files.exists(Path.of("src", "main", "java", "com", "zhiqu", "cli")), "com.zhiqu.cli 还在");
    }

    private static String read(Path path) throws IOException {
        String text = Files.readString(path, StandardCharsets.UTF_8);
        StringBuilder out = new StringBuilder();
        for (String line : text.split("\n", -1)) {
            String trimmed = line.stripLeading();
            if (trimmed.startsWith("#") || trimmed.startsWith("//")) {
                continue;
            }
            out.append(line).append('\n');
        }
        return out.toString();
    }

    /**
     * 第九十六轮：网页代码模式跑命令行那份循环要 node —— 打进应用包；打不进去就别出包。
     * 第一百二十五轮起包里没有后端了，node 留给本机代码助手（方案第 2 步，外壳按需起它）。
     */
    @Test
    @DisplayName("macOS 应用包带可搬移的 node；准备失败在清理旧包之前停止，签名后再次验证")
    void 应用包带node() throws IOException {
        String script = read(NATIVE_SCRIPT);
        assertTrue(script.contains("cp \"$NODE_BIN\" \"$APP/Contents/Resources/node/bin/node\""), "打包脚本没把 node 放进应用包");
        int prepare = script.indexOf("NODE_BIN=\"$(bash \"$ROOT/deploy/desktop/prepare-macos-node.sh\"");
        int clean = script.indexOf("rm -rf \"$OUT\"");
        assertTrue(prepare >= 0 && clean > prepare, "准备 Node 必须在删除旧产物之前，否则缺库时会丢上一个安装包");
        assertTrue(script.indexOf("Resources/node/bin/node") < script.indexOf("codesign"), "node 要在签名之前放进去，否则签名不覆盖它");
        assertTrue(script.contains("codesign --verify --deep --strict \"$APP\"")
                        && script.lastIndexOf("\"$APP/Contents/Resources/node/bin/node\" --version") > script.indexOf("codesign --force"),
                "签名失败要停下，签名后还要验证包里的 Node 真的能跑");
        assertFalse(script.contains("|| true"), "签名或 Node 准备失败不许被吞掉");
        assertTrue(script.contains("node/LICENSE"), "官方 Node 的 LICENSE 要随运行时分发");
    }
}
