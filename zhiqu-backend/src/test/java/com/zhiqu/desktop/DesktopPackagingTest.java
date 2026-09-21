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
 * <p>这一类东西不在 Java 代码里，所以平时的判据一条都覆盖不到它们；而它们出问题的方式
 * 有个共同点：<b>报错完全指不到真正的原因</b>，且只在打包后的产物里复现，开发机上永远正常。
 */
class DesktopPackagingTest {

    private static final Path NATIVE_SCRIPT = Path.of("..", "deploy", "desktop", "package-macos-native.sh");
    private static final Path JPACKAGE_SCRIPT = Path.of("..", "deploy", "desktop", "package-macos.sh");

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
    @DisplayName("jpackage 版必须关 headless —— 否则 Dock 图标无限弹跳")
    void jpackage版必须关headless() throws IOException {
        String script = read(JPACKAGE_SCRIPT);
        assertTrue(script.contains("jpackage"), "扫到的不是 jpackage 脚本 —— 空扫会假绿");
        assertTrue(script.contains("-Djava.awt.headless=false"),
                "jpackage 产出的是 Foreground 类型应用，macOS 会一直弹跳图标直到进程连上"
                        + "窗口服务器；headless 的 JVM 永远不会连（lsappinfo 报 !cgsConnection）。"
                        + "这个开关只能走 JVM 参数 —— spring.main.headless 绑定得太晚。");
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
