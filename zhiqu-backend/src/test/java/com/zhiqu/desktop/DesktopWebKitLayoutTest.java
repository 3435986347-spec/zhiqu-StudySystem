package com.zhiqu.desktop;

import com.zhiqu.NodeRunner;
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
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * 第五十三轮：在真的 WebKit 里量样子。用户在桌面应用（WKWebView）里看到三处，内置浏览器（Chromium）里要么没有、要么不明显：
 * 看板「本周」的日期出了格子（窄的日历一格 40px，「周一」和日期并排要 74px）；番茄钟的「关联任务」下拉框撑出卡片（WebKit 的原生下拉按最长的选项定宽）；
 * 下拉框是原生的灰渐变（样式表用的 appearance: base-select 只有 Chromium 认）。
 *
 * <p>标记是发布的那份：日历由 week-markup.js 真跑 dashboard.js 的 renderWeek 画出来，番茄钟卡片从 dashboard.html 里原样截出来；
 * 样式表是发布的 zhiqu-ui.css。检查程序不开窗口（用户说过预览不要弹窗口）。没有 swiftc 明确失败，要跳过写 {@code -Dzhiqu.skipSwiftTests=true}。
 */
class DesktopWebKitLayoutTest {

    private static final Path STATIC = Path.of("src/main/resources/static");

    @TempDir
    Path tmp;

    @Test
    @DisplayName("WebKit 里：日历、下拉框不溢出；Wiki 阅读与编辑使用可用宽度，手机上长文本、图片、代码和表格不会撑宽正文")
    void 在WebKit里量() throws Exception {
        Map<String, String> out = runCheck();
        assertEquals("7", out.get("days"), "日历没画出七天：" + out);
        assertEquals("column", out.get("narrowHead"), "窄的日历（322px，960 宽的窗口里）还是星期和日期并排");
        assertTrue(Double.parseDouble(out.get("narrowOverflow")) <= 0.5, "窄的日历里日期出了格子 " + out.get("narrowOverflow") + "px（用户在桌面应用里看到的）");
        assertEquals("row", out.get("wideHead"), "宽的日历（802px）也换成了竖排 —— 那里放得下并排");
        assertTrue(Double.parseDouble(out.get("wideOverflow")) <= 0.5, "宽的日历里日期出了格子 " + out.get("wideOverflow") + "px");
        assertTrue(Double.parseDouble(out.get("tinyOverflow")) <= 0.5, "320 宽的手机上（日历 200）星期 / 日期出了格子 " + out.get("tinyOverflow") + "px");
        assertTrue(Double.parseDouble(out.get("selectOver")) <= 0.5, "番茄钟的「关联任务」下拉框撑出卡片 " + out.get("selectOver") + "px（任务名长的时候）");
        // 新版 WebKit 已支持 base-select；CSS 在支持时采用它，不支持时才显式去掉原生 appearance。
        // JSONSerialization 把 CSS.supports 的布尔值转成 NSNumber，探针打印为 1 / 0；缺失不能当成不支持。
        String baseSelect = out.get("baseSelect");
        assertTrue("1".equals(baseSelect) || "0".equals(baseSelect), "探针没有报告有效的 base-select 支持状态：" + out);
        String expectedAppearance = "1".equals(baseSelect) ? "base-select" : "none";
        assertEquals(expectedAppearance, out.get("selectAppearance"), "番茄钟下拉没有采用当前 WebKit 对应的自定义样式");
        assertEquals(expectedAppearance, out.get("modelAppearance"), "AI 助手的模型下拉没有采用当前 WebKit 对应的自定义样式");
        assertEquals("6", out.get("wikiCases"), "Wiki 阅读和编辑、宽窄三种容器没有全部量到：" + out);
        for (String size : new String[]{"wide", "narrow", "tiny"}) {
            for (String mode : new String[]{"read", "edit"}) {
                String key = "wiki." + size + "." + mode;
                assertTrue(Math.abs(Double.parseDouble(out.get(key + ".unusedWidth"))) <= 0.5,
                        key + " 正文没有使用容器宽度，右边空了 " + out.get(key + ".unusedWidth") + "px");
                assertTrue(Double.parseDouble(out.get(key + ".overflow")) <= 0.5,
                        key + " 的长文本 / 图片 / 表格 / 代码撑出正文 " + out.get(key + ".overflow") + "px");
                assertTrue(Double.parseDouble(out.get(key + ".codeScroll")) > 0,
                        key + " 的长代码没有在自己的代码块里横向滚动");
                assertTrue(Double.parseDouble(out.get(key + ".tableScroll")) > 0,
                        key + " 的宽表格没有在自己的表格容器里横向滚动");
            }
        }
        // 第八十四轮：页名搬到正文顶上，工具栏那一行只剩工具
        assertEquals("2", out.get("wikiToolbarCases"), "宽窄两种工具栏探针没有全部执行：" + out);
        for (String key : new String[]{"wide", "narrow"}) {
            assertTrue(Math.abs(Double.parseDouble(out.get("wikiToolbar." + key + ".rightGap"))) <= 0.5,
                    key + " 工具栏没有贴在内容区右侧：" + out);
            assertTrue(Double.parseDouble(out.get("wikiToolbar." + key + ".overflow")) <= 0.5,
                    key + " 工具栏撑出那一行：" + out);
        }
        assertTrue(Double.parseDouble(out.get("inlineTitle.overflow")) <= 0.5, "很长的页名在窄窗口里撑出正文：" + out);
        assertTrue(Integer.parseInt(out.get("inlineTitle.lines")) >= 2, "很长的页名没有折行：" + out);
    }

    private Map<String, String> runCheck() throws Exception {
        Assumptions.assumeTrue(System.getProperty("os.name", "").toLowerCase().contains("mac"), "WKWebView 只在 macOS 上");
        Assumptions.assumeFalse(Boolean.getBoolean("zhiqu.skipSwiftTests"), "按 -Dzhiqu.skipSwiftTests=true 跳过");
        if (!new File("/usr/bin/swiftc").canExecute()) {
            fail("这台 Mac 上没有 swiftc（xcode-select --install），WebKit 里的样子量不了；确实要跳过就加 -Dzhiqu.skipSwiftTests=true");
        }
        Path work = Files.createDirectories(tmp.resolve("page"));
        Files.copy(STATIC.resolve("assets/zhiqu-ui.css"), work.resolve("zhiqu-ui.css"));
        Files.writeString(work.resolve("wiki-header.html"), wikiHeader(Files.readString(STATIC.resolve("knowledge-wiki.html"), StandardCharsets.UTF_8)), StandardCharsets.UTF_8);
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/week-markup.js"), STATIC.resolve("assets/pages/dashboard.js"), work.resolve("week.html").toString()),
                "week-markup.js 没画出日历");
        Files.writeString(work.resolve("pomo.html"), pomodoroCard(Files.readString(STATIC.resolve("dashboard.html"), StandardCharsets.UTF_8)), StandardCharsets.UTF_8);
        Path src = Files.createDirectories(tmp.resolve("src"));
        Files.copy(Path.of("src/test/resources/swift/webkit-layout-check.swift"), src.resolve("main.swift"));
        Path bin = tmp.resolve("check");
        DesktopPageViewTest.run(600, "/usr/bin/swiftc", "-O", "-framework", "AppKit", "-framework", "WebKit", "-o", bin.toString(), src.resolve("main.swift").toString());
        String text = DesktopPageViewTest.run(90, bin.toString(), work.toString());
        Map<String, String> map = new HashMap<>();
        for (String line : text.split("\n")) {
            int eq = line.indexOf('=');
            if (eq > 0) map.put(line.substring(0, eq), line.substring(eq + 1));
        }
        assertEquals("true", map.get("done"), "检查程序没有走完：\n" + text);
        return map;
    }

    /** 发布页面的工具栏那一行（.zq-wiki-head，第八十四轮起不含页名），按 div 层数截取 */
    static String wikiHeader(String html) {
        int at = html.indexOf("<div class=\"zq-wiki-head\">");
        assertTrue(at >= 0, "knowledge-wiki.html 里找不到工具栏那一行（.zq-wiki-head）");
        Matcher m = Pattern.compile("<div\\b|</div>").matcher(html);
        int depth = 0, from = at;
        while (m.find(from)) {
            depth += m.group().startsWith("</") ? -1 : 1;
            from = m.end();
            if (depth == 0) return html.substring(at, m.end());
        }
        throw new AssertionError("知识页标题与工具栏的 <div> 没有闭合");
    }

    /** dashboard.html 里番茄钟那张卡片，原样截出来（按 div 的层数配对） */
    static String pomodoroCard(String html) {
        String open = "<div class=\"zq-card zq-card-lg zq-pomo\">";
        int at = html.indexOf(open);
        assertTrue(at >= 0, "dashboard.html 里找不到番茄钟那张卡片");
        Matcher m = Pattern.compile("<div\\b|</div>").matcher(html);
        int depth = 0, from = at;
        while (m.find(from)) {
            depth += m.group().startsWith("</") ? -1 : 1;
            from = m.end();
            if (depth == 0) return html.substring(at, m.end());
        }
        throw new AssertionError("番茄钟那张卡片的 <div> 没有闭合");
    }
}
