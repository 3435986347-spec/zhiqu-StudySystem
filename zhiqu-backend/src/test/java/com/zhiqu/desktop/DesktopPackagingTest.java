package com.zhiqu.desktop;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 钉住打包脚本里那几个「看起来可有可无、删了要到运行时才炸」的开关。
 *
 * <p>2026-09-22 退掉了 macOS 的 jpackage 版打包脚本（它双击后弹系统浏览器，已被原生外壳
 * 取代），随之退掉那条「jpackage 版必须关 headless」—— 同一条知识由
 * {@link #Windows脚本要关headless()} 继续钉着，{@code package-windows.ps1} 也走 jpackage。
 *
 * <p>这一类东西不在 Java 代码里，所以平时的判据一条都覆盖不到它们；而它们出问题的方式
 * 有个共同点：<b>报错完全指不到真正的原因</b>，且只在打包后的产物里复现，开发机上永远正常。
 */
class DesktopPackagingTest {

    private static final Path NATIVE_SCRIPT = Path.of("..", "deploy", "desktop", "package-macos-native.sh");

    @Test
    @DisplayName("jlink 必须带 jdk.charsets —— 否则 MySQL 连接会协商成 eucjpms，中文全写不进去")
    void jlink必须带字符集模块() throws IOException {
        String script = read(NATIVE_SCRIPT);
        assertTrue(script.contains("--add-modules"), "扫到的不是打包脚本 —— 空扫会假绿");

        assertTrue(script.contains("jdk.charsets"),
                "jlink 的模块列表里没有 jdk.charsets。2026-09-21 实测：缺了它，"
                        + "MySQL 驱动把 character_set_client 协商成 eucjpms（日文字符集），"
                        + "所有中文明文写入报 Incorrect string value —— 而表、列、JDBC URL "
                        + "三处写的都是 utf8mb4，查起来指不到这里。");
    }

    @Test
    @DisplayName("jlink 必须带 jdk.crypto.ec —— 否则 HTTPS 握手失败，报错像是对端的问题")
    void jlink必须带椭圆曲线模块() throws IOException {
        assertTrue(read(NATIVE_SCRIPT).contains("jdk.crypto.ec"),
                "缺了它，连远程数据库和 AI 服务商的 TLS 会报「找不到合适的套件」");
    }

    @Test
    @DisplayName("原生外壳版相反：JVM 要保持 headless —— 外壳自己才是 GUI 进程")
    void 原生外壳版要保持headless() throws IOException {
        String shell = read(Path.of("..", "deploy", "desktop", "macos-shell", "ZhiquShell.swift"));
        assertTrue(shell.contains("WKWebView"), "扫到的不是外壳源码 —— 空扫会假绿");
        assertTrue(shell.contains("-Djava.awt.headless=true"),
                "外壳版里 JVM 只是后台子进程。让它也去连窗口服务器会在 Dock 里多出一个图标。");
        assertFalse(shell.contains("-Djava.awt.headless=false"),
                "两个版本的取向相反，抄串了会多一个 Dock 图标");
    }

    @Test
    @DisplayName("原生外壳要把端口文件属性传给后端 —— 否则后端会另外弹一个浏览器")
    void 外壳要传端口文件属性() throws IOException {
        assertTrue(read(Path.of("..", "deploy", "desktop", "macos-shell", "ZhiquShell.swift"))
                        .contains(DesktopLauncher.PORT_FILE_PROPERTY),
                "外壳没传 " + DesktopLauncher.PORT_FILE_PROPERTY
                        + "，后端会走回退分支去开系统浏览器 —— 用户同时得到一个应用窗口和一个浏览器标签页");
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
    @DisplayName("桌面 profile 必须用固定端口 —— 随机端口会让「记住登录」每次失效")
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

        // 原生外壳必须连同一个固定端口，否则外壳与后端各说各的端口
        String shell = read(Path.of("..", "deploy", "desktop", "macos-shell", "ZhiquShell.swift"));
        assertTrue(shell.contains("static let port = " + port),
                "外壳里的固定端口和 application-desktop.yml 的 " + port + " 对不上 —— "
                        + "两处各写一个端口，界面会连到后端没监听的那个。");
    }

    // ── 命令行入口 zhiqu ────────────────────────────────────────────────

    private static final Path CLI_SCRIPT = Path.of("..", "deploy", "desktop", "bin", "zhiqu");

    /**
     * 包里要有 zhiqu，而且能执行。
     *
     * <p>少了拷贝那一行，打出来的应用照样能用 —— 只是命令行入口不存在，用户照着文档
     * 建软链会指向一个空位置，报的是「No such file or directory」，读起来像他自己敲错了。
     */
    @Test
    @DisplayName("打包脚本把 zhiqu 拷进 Contents/Resources/bin 并加可执行权限")
    void 包里要有命令行入口() throws IOException {
        String script = read(NATIVE_SCRIPT);
        assertTrue(script.contains("cp \"$ROOT/deploy/desktop/bin/zhiqu\" \"$APP/Contents/Resources/bin/zhiqu\""),
                "打包脚本没有把 zhiqu 拷进应用包");
        assertTrue(script.contains("chmod +x \"$APP/Contents/Resources/bin/zhiqu\""),
                "拷进去的 zhiqu 没有可执行权限 —— 敲 zhiqu 会报 Permission denied");
        assertTrue(Files.isExecutable(CLI_SCRIPT),
                "仓库里的 deploy/desktop/bin/zhiqu 没有可执行位（git 会记住这一位，丢了要 chmod +x 再提交）");
    }

    /**
     * 启动脚本点名一个入口类。入口类改名或挪包时，脚本里那个字符串不会报编译错误 —— 只会在用户敲 zhiqu 时
     * 报 ClassNotFoundException。所以这里拿脚本里写的类名去真的加载一次。
     *
     * <p>第十轮起应用里放的是<b>解压后的瘦 JAR</b>（为了 CDS 启动加速），它的 Class-Path 指向 lib/，
     * 直接 {@code -cp} 它就能跑；原来胖 JAR 那套 PropertiesLauncher + loader.main 在瘦 JAR 里根本不存在 ——
     * 脚本要是还写着它，敲 zhiqu 就是 ClassNotFoundException。
     */
    @Test
    @DisplayName("zhiqu 脚本指向的入口类真实存在且有 main；直接 -cp 瘦 JAR，不再走胖 JAR 的 PropertiesLauncher；用应用自带的 JRE")
    void 命令行入口类要存在() throws Exception {
        String script = read(CLI_SCRIPT);
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("-cp \"\\$JAR\" ([\\w.]+)").matcher(script);
        assertTrue(m.find(), "zhiqu 脚本里找不到 -cp \"$JAR\" <入口类> —— 判据的锚点没了");
        Class<?> entry = Class.forName(m.group(1));
        assertTrue(java.lang.reflect.Modifier.isStatic(entry.getMethod("main", String[].class).getModifiers()),
                m.group(1) + " 没有 public static void main(String[])");
        assertFalse(script.contains("PropertiesLauncher") || script.contains("loader.main"),
                "zhiqu 还在走胖 JAR 的 PropertiesLauncher —— 应用里现在是瘦 JAR，那个类不存在");
        assertTrue(script.contains("runtime/Contents/Home/bin/java"),
                "zhiqu 没用应用自带的 JRE —— 用户机器上不一定装了 Java 17");
    }

    /**
     * 启动加速（第十轮，实测 3.3 秒 → 1.7 秒）的三个前提，少一个就悄悄回到慢的那条路 —— 应用照常能用，没人会发现：
     * 运行时带基础归档（没有它，生成应用类归档那一步直接跳过）、放解压后的瘦 JAR（胖 JAR 里的类一个都归档不了）、
     * 外壳把 CdsCache 编进去并在 -jar 之前加上它的参数、退出时收尾。
     */
    @Test
    @DisplayName("启动加速：jlink 生成基础 CDS 归档；应用里放解压的瘦 JAR；外壳编进 CdsCache、参数在 -jar 之前、退出时收尾")
    void 启动加速的前提() throws IOException {
        String script = read(NATIVE_SCRIPT);
        assertTrue(script.contains("--generate-cds-archive"), "jlink 没生成基础 CDS 归档");
        assertTrue(script.contains("-Djarmode=tools -jar \"$JAR\" extract --destination \"$APP/Contents/Resources/app\""),
                "应用里不是解压后的瘦 JAR");
        assertFalse(script.contains("cp \"$JAR\" \"$APP/Contents/Resources/app/\""), "胖 JAR 又被拷进去了");
        assertTrue(script.contains("macos-shell/CdsCache.swift"), "CdsCache.swift 没编进外壳");
        String shell = read(Path.of("..", "deploy", "desktop", "macos-shell", "ZhiquShell.swift"));
        int args = shell.indexOf("process.arguments = cache.jvmArguments() + [");
        assertTrue(args > 0, "外壳没把 CDS 参数加在 JVM 参数最前面（必须在 -jar 之前，之后的会被当成应用参数）");
        assertTrue(shell.indexOf("\"-jar\", runJar.path") > args, "外壳没从 ASCII 路径的副本跑（中文路径下应用类只归档一小部分）");
        assertTrue(shell.contains("CdsCache(directory: home.appendingPathComponent(\".zhiqu/cds\"), jar: runJar"),
                "归档要按实际运行的那个 JAR 算");
        assertTrue(shell.contains("cds?.finish(cleanExit: !killed)"), "退出时没收尾：生成的归档永远是 .part，下次还是慢的");
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
}
