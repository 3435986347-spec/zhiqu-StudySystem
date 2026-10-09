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
    @DisplayName("WebKit 里：窄的日历换成竖排、日期不出格子（一直窄到 320 宽的手机），宽的照旧并排；番茄钟的下拉框不出卡片；下拉框不是原生的样子")
    void 在WebKit里量() throws Exception {
        Map<String, String> out = runCheck();
        assertEquals("7", out.get("days"), "日历没画出七天：" + out);
        assertEquals("column", out.get("narrowHead"), "窄的日历（322px，960 宽的窗口里）还是星期和日期并排");
        assertTrue(Double.parseDouble(out.get("narrowOverflow")) <= 0.5, "窄的日历里日期出了格子 " + out.get("narrowOverflow") + "px（用户在桌面应用里看到的）");
        assertEquals("row", out.get("wideHead"), "宽的日历（802px）也换成了竖排 —— 那里放得下并排");
        assertTrue(Double.parseDouble(out.get("wideOverflow")) <= 0.5, "宽的日历里日期出了格子 " + out.get("wideOverflow") + "px");
        assertTrue(Double.parseDouble(out.get("tinyOverflow")) <= 0.5, "320 宽的手机上（日历 200）星期 / 日期出了格子 " + out.get("tinyOverflow") + "px");
        assertTrue(Double.parseDouble(out.get("selectOver")) <= 0.5, "番茄钟的「关联任务」下拉框撑出卡片 " + out.get("selectOver") + "px（任务名长的时候）");
        assertEquals("none", out.get("selectAppearance"), "WebKit 里下拉框还是原生的灰渐变（base-select 只有 Chromium 认）");
        assertEquals("none", out.get("modelAppearance"), "AI 助手的模型下拉在 WebKit 里还是原生的样子");
        // 哪天 WebKit 也认 base-select 了，上面那两条照样成立（走的是 base-select 那套）；这里只记下来
        assertTrue(out.containsKey("baseSelect"));
    }

    private Map<String, String> runCheck() throws Exception {
        Assumptions.assumeTrue(System.getProperty("os.name", "").toLowerCase().contains("mac"), "WKWebView 只在 macOS 上");
        Assumptions.assumeFalse(Boolean.getBoolean("zhiqu.skipSwiftTests"), "按 -Dzhiqu.skipSwiftTests=true 跳过");
        if (!new File("/usr/bin/swiftc").canExecute()) {
            fail("这台 Mac 上没有 swiftc（xcode-select --install），WebKit 里的样子量不了；确实要跳过就加 -Dzhiqu.skipSwiftTests=true");
        }
        Path work = Files.createDirectories(tmp.resolve("page"));
        Files.copy(STATIC.resolve("assets/zhiqu-ui.css"), work.resolve("zhiqu-ui.css"));
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
