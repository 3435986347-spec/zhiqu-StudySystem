package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 界面打磨第 3 步（第四十三轮，docs/ui-plan.md）：外壳。
 * 原来 11 个页面的头部各写各的内联样式（对齐、间距、说明那一行的字号都不一样），标题上面还有一行和侧栏重复的小字，
 * 任务页、例行计划页右上角各有一个和侧栏重复的「返回看板」。AI 助手是三层颜色：页面底色上一张白卡片（描边 + 阴影），
 * 卡片里的头部条和两侧面板是浅灰 —— 用户 2026-10-06：「在 ai 助手那里，底色和展开旁边的颜色不要区分会不会更好」。
 * 侧栏的收起按钮的判据在 ui-shell-check.js 里（真跑 zhiqu-ui.js），这里只管样式表那一半。
 */
class PageHeadTest {

    private static final Path STATIC = Path.of("src/main/resources/static");

    private static String read(Path p) throws IOException {
        return Files.readString(p, StandardCharsets.UTF_8);
    }

    private static String css() throws IOException {
        return SourceText.stripComments(read(STATIC.resolve("assets/zhiqu-ui.css")));
    }

    /** 从 at 处的开标签开始，找到配对的闭标签，返回整段 */
    private static String elementAt(String html, int at, String tag) {
        Matcher m = Pattern.compile("<" + tag + "\\b|</" + tag + ">").matcher(html);
        int depth = 0;
        int from = at;
        while (m.find(from)) {
            depth += m.group().startsWith("</") ? -1 : 1;
            from = m.end();
            if (depth == 0) return html.substring(at, m.end());
        }
        throw new AssertionError("<" + tag + "> 没有闭合");
    }

    /** 每个有 .zq-main 的页面里的第一个 <header>（页面头部） */
    private static List<String[]> pageHeads() throws IOException {
        List<Path> pages;
        try (Stream<Path> list = Files.list(STATIC)) {
            pages = list.filter(p -> p.toString().endsWith(".html")).sorted().collect(Collectors.toList());
        }
        List<String[]> heads = new ArrayList<>();
        for (Path p : pages) {
            String html = read(p);
            int main = html.indexOf("<main class=\"zq-main\"");
            int at = main < 0 ? -1 : html.indexOf("<header", main);
            if (at < 0) continue;   // 落地页、旧地址的跳转页
            heads.add(new String[]{p.getFileName().toString(), elementAt(html, at, "header")});
        }
        return heads;
    }

    @Test
    @DisplayName("每个页面的头部一种写法：.zq-page-head，标题（+ 一行说明）在左、操作在右；没有内联样式、没有标题上面那行小字、没有和侧栏重复的「返回看板」")
    void 页面头部一种写法() throws IOException {
        List<String[]> heads = pageHeads();
        assertTrue(heads.size() >= 11, "只找到 " + heads.size() + " 个页面头部");
        List<String> bad = new ArrayList<>();
        for (String[] h : heads) {
            String page = h[0], head = h[1];
            if (!head.startsWith("<header class=\"zq-page-head\">")) bad.add(page + "：头部不是 <header class=\"zq-page-head\">");
            if (!head.contains("<h1 class=\"zq-h1\">")) bad.add(page + "：头部没有 <h1 class=\"zq-h1\">");
            if (head.contains("zq-eyebrow")) bad.add(page + "：标题上面又有一行小字（侧栏已经亮着在哪一页）");
            if (head.contains("href=\"dashboard.html\"")) bad.add(page + "：头部又有「返回看板」（侧栏里就有看板）");
            // 操作那一侧放什么各页不同（按钮、搜索框、筛选），里面的内联样式不管；标题那一侧和头部本身一律走类
            String rest = head;
            int actions = head.indexOf("<div class=\"zq-page-actions");
            if (actions >= 0) {
                if (!head.startsWith("<div class=\"zq-page-actions\">", actions)) bad.add(page + "：操作那一侧的 <div> 带了别的属性");
                String block = elementAt(head, actions, "div");
                rest = head.replace(block, "");
            }
            if (rest.contains("style=")) bad.add(page + "：头部（操作那一侧以外）还有内联样式");
        }
        assertEquals(List.of(), bad, "页面头部又各写各的了");
    }

    @Test
    @DisplayName("页面头部的样式只在 zhiqu-ui.css 定义一次：放不下就换行（窄屏上按钮不挤标题）")
    void 头部的样式() throws IOException {
        String css = css();
        for (String sel : List.of(".zq-page-head{", ".zq-page-sub{", ".zq-page-actions{", ".zq-page-head>div:first-child{")) {
            int n = css.split(Pattern.quote(sel), -1).length - 1;
            assertEquals(1, n, sel + " 应该恰好定义一次，现在是 " + n + " 次");
        }
        Matcher head = Pattern.compile("\\.zq-page-head\\{([^}]*)\\}").matcher(css);
        assertTrue(head.find());
        assertTrue(head.group(1).contains("display:flex") && head.group(1).contains("justify-content:space-between") && head.group(1).contains("flex-wrap:wrap"),
                "页面头部要左右两侧、放不下就换行：" + head.group(1));
        assertTrue(css.contains(".zq-page-head>div:first-child{min-width:0;}"), "标题那一侧没有 min-width:0 —— 长说明会把头部撑出页面、省略号也不出来");
        // 看板的日期写在说明那一行里（dashboard.js 按类找它；原来找的是「头部里第一个 span」，换了写法就会写到别处去）
        String board = read(STATIC.resolve("dashboard.html"));
        String boardHead = pageHeads().stream().filter(h -> h[0].equals("dashboard.html")).findFirst().orElseThrow()[1];
        assertEquals(1, boardHead.split("class=\"zq-page-sub\"", -1).length - 1, "看板头部要有恰好一个 .zq-page-sub（写日期的地方）");
        assertTrue(board.contains("<span class=\"zq-page-sub\">—</span>"), "看板的日期占位不见了");
        assertTrue(SourceText.pageModule("dashboard.js").contains("var headerDate = $('.zq-page-sub');"), "看板的日期没有写到说明那一行");
    }

    @Test
    @DisplayName("AI 助手一种底色（用户说的）：没有白卡片（描边、阴影）、两侧面板和页面同一个底色、头部条里不再重复写「AI 助手」")
    void AI助手一种底色() throws IOException {
        String html = read(STATIC.resolve("ai-assistant.html"));
        int main = html.indexOf("<main class=\"zq-main\"");
        int at = html.indexOf("<section", main);
        assertTrue(main > 0 && at > main, "找不到 AI 助手的工作区 <section>");
        String sectionTag = html.substring(at, html.indexOf('>', at) + 1);
        for (String no : List.of("background", "box-shadow", "border-radius", "border:")) {
            assertFalse(sectionTag.contains(no), "工作区又成了一张卡片（" + no + "）：" + sectionTag);
        }
        Matcher aside = Pattern.compile("<aside data-zq-collapse=\"(left|right)\"[^>]*style=\"([^\"]*)\"").matcher(html);
        int asides = 0;
        while (aside.find()) {
            asides++;
            // 手机上展开的面板浮在对话区上面，所以要有不透明的底色 —— 和页面一样的那一个
            assertTrue(aside.group(2).contains("background:var(--zq-bg);"), aside.group(1) + " 面板的底色不是页面底色：" + aside.group(2));
        }
        assertEquals(2, asides, "AI 助手应该有左右两个可收起的面板");
        String section = elementAt(html, at, "section");
        assertFalse(section.contains("background:var(--zq-card-soft);\">"), "工作区里又有一条浅灰的头部条");
        assertEquals(1, html.split(">AI 助手<", -1).length - 1, "「AI 助手」在页面上应该只写一次（页面标题）");
        String head = pageHeads().stream().filter(h -> h[0].equals("ai-assistant.html")).findFirst().orElseThrow()[1];
        assertTrue(head.contains("id=\"zq-current-notebook\"") && head.contains("id=\"zq-sync-count\""), "当前 Notebook、同步状态要在页面头部（原来那条头部条去掉了）");

        // 两侧面板的收起 / 展开按钮只是图标：白底描边的小方块在一种底色上很跳
        String css = css();
        for (String sel : List.of(".zq-cbtn{", ".zq-rail .zq-xbtn{")) {
            Matcher m = Pattern.compile(Pattern.quote(sel) + "([^}]*)\\}").matcher(css);
            assertTrue(m.find(), "找不到 " + sel);
            assertTrue(m.group(1).contains("border:none") && m.group(1).contains("background:transparent"), sel + " 又有描边或底色：" + m.group(1));
        }
    }

    @Test
    @DisplayName("侧栏：收起后品牌标志和收起按钮上下排；导航项、收起按钮在键盘焦点上有焦点环")
    void 侧栏的样式() throws IOException {
        String css = css();
        assertTrue(css.contains(".zq-side.is-collapsed .zq-brand{flex-direction:column;"), "收起后（56px 宽）品牌那一行放不下标志 + 按钮，要上下排");
        Matcher toggle = Pattern.compile("\\.zq-side-toggle\\{([^}]*)\\}").matcher(css);
        assertTrue(toggle.find(), "找不到 .zq-side-toggle");
        assertFalse(toggle.group(1).contains("width:100%"), "收起按钮又成了一整条：" + toggle.group(1));
        Matcher focus = Pattern.compile("([^{}]+)\\{([^{}]*)\\}").matcher(css);
        boolean nav = false, tg = false;
        while (focus.find()) {
            if (!focus.group(2).contains("box-shadow:var(--zq-focus)")) continue;
            List<String> sels = List.of(focus.group(1).trim().split("\\s*,\\s*"));
            nav |= sels.contains(".zq-nav a:focus-visible");
            tg |= sels.contains(".zq-side-toggle:focus-visible");
        }
        assertTrue(nav, "键盘走到导航项上没有焦点环");
        assertTrue(tg, "键盘走到收起按钮上没有焦点环");
    }
}
