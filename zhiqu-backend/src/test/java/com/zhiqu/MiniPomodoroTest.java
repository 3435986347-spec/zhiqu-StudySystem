package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 迷你番茄钟第 2 步（第五十轮，docs/mini-pomodoro-plan.md）：mini.html —— 一个半透明的深色胶囊，第 3 步 macOS 外壳把它装进悬浮面板。
 * 钟在壳里（第四十九轮，PomodoroSharedTest）；这里管胶囊的画法和按钮（mini-check.js 真跑 mini.js）、它和别的页不一样的几处，
 * 以及第五十轮照出来的那一类：新加的页面不在 SecurityConfig 的放行清单里，一打开就是空白（403）。
 */
class MiniPomodoroTest {

    private static final Path STATIC = Path.of("src/main/resources/static");

    private static String read(Path p) throws IOException {
        return Files.readString(p, StandardCharsets.UTF_8);
    }

    @Test
    @DisplayName("胶囊的画法：待开始 / 专注中 / 已暂停 / 专注结束，按钮交给壳，展开走外壳的桥（浏览器里去看板），「第 N 轮」只有这一块也填得上")
    void 画法() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/mini-check.js"), STATIC.resolve("assets/pages/mini.js"), NodeRunner.API_JS.toString()),
                "mini-check.js 没有全绿");
    }

    @Test
    @DisplayName("每一个页面都在 SecurityConfig 的放行清单里（第五十轮：新加的 mini.html 一打开是空白 —— 403、没有正文，页面上什么都看不出来）")
    void 每一页都放行() throws IOException {
        String security = SourceText.stripComments(read(Path.of("src/main/java/com/zhiqu/config/SecurityConfig.java")));
        List<String> pages = new ArrayList<>();
        try (Stream<Path> list = Files.list(STATIC)) {
            list.filter(p -> p.toString().endsWith(".html")).sorted().forEach(p -> pages.add(p.getFileName().toString()));
        }
        assertTrue(pages.size() >= 15, "只扫到 " + pages.size() + " 个页面");
        List<String> blocked = new ArrayList<>();
        for (String page : pages) {
            if (!security.contains("\"/" + page + "\"")) blocked.add(page);
        }
        assertEquals(List.of(), blocked, "这些页面没放行 —— 没登录时拿到 403（页面要先打开、自己去登录），打开就是一片空白");
    }

    @Test
    @DisplayName("和别的页不一样的几处：没有侧栏；页面透明、胶囊盖过手机宽那段让侧栏的边距；没登录不跳登录页、写一句；登记成页面模块、离线也打得开")
    void 接线() throws IOException {
        String html = read(STATIC.resolve("mini.html"));
        assertTrue(html.contains("class=\"zq-mini-page\""), "mini.html 的 <html> 上没有 zq-mini-page —— 胶囊的样式（透明、不让侧栏）都挂在它上面");
        assertFalse(html.contains("id=\"zq-side\""), "迷你窗不要侧栏");
        assertTrue(html.contains("<div class=\"zq-mini-out\">在主窗口登录后再用</div>"), "没登录时那一句不在页面里");

        String css = SourceText.stripComments(read(STATIC.resolve("assets/zhiqu-ui.css")));
        assertTrue(css.contains("html.zq-mini-page,html.zq-mini-page body{background:transparent;"), "迷你页的底不透明 —— 悬浮面板里会露出一块方的底色");
        // 这个窗口比手机还窄：最后那段 @media 里 .zq-main 要让出侧栏的 56px，胶囊的选择器要压得过（.zq-main.is-side-collapsed 是两个类）
        assertTrue(css.contains("html.zq-mini-page .zq-main{display:flex;") && css.contains("margin:6px;"),
                "胶囊的 .zq-main 没有盖过手机宽那段 @media 的 margin-left:56px");
        assertTrue(css.contains("html.zq-signed-out .zq-mini-out{display:block;}"), "没登录时那一句亮不出来");

        String js = SourceText.stripComments(read(NodeRunner.API_JS));
        assertTrue(js.contains("'mini.html': 'pages/mini.js'"), "PAGE_MODULES 里没有 mini.html");
        String redirect = SourceText.functionBody(js, "function redirectToLogin()");
        int mini = redirect.indexOf("if (page === 'mini.html') { redirecting = true; document.documentElement.classList.add('zq-signed-out'); return; }");
        assertTrue(mini > 0 && mini < redirect.indexOf("location.replace("), "迷你窗没登录时会自己换成登录页（一个胶囊里塞不下）：\n" + redirect);

        String sw = read(STATIC.resolve("service-worker.js"));
        assertTrue(sw.contains("'/mini.html',"), "service-worker 的核心资源里没有 mini.html —— 断网时迷你窗打不开");
    }
}
