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
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 手机（第二十轮）：375px / 320px 宽、浏览器放大到 200% 时页面要能用。
 *
 * <p>这些判据都是在真浏览器里量出来的问题（量法和数字见 docs/rounds/round-20.md），这里钉的是修法的结构，
 * 让它们不会悄悄退回去 —— 页面级的多栏布局都写在内联 style 里，手机样式只能按 style 属性的字面认，
 * 这种「按字面认」的耦合在代码评审里看不出来。
 */
class MobileLayoutTest {

    private static final Path STATIC = Path.of("src", "main", "resources", "static");

    private static String css() throws IOException {
        return SourceText.stripComments(Files.readString(STATIC.resolve("assets/zhiqu-ui.css"), StandardCharsets.UTF_8));
    }

    private static String uiJs() throws IOException {
        return SourceText.stripComments(Files.readString(STATIC.resolve("assets/zhiqu-ui.js"), StandardCharsets.UTF_8));
    }

    private static String apiJs() throws IOException {
        return SourceText.stripComments(Files.readString(STATIC.resolve("assets/zhiqu-api.js"), StandardCharsets.UTF_8));
    }

    private static String stripHtmlComments(String html) {
        return html.replaceAll("(?s)<!--.*?-->", " ");
    }

    /** 手机那段 @media 的内容（不含外层花括号）和它结束的位置。 */
    private record MediaBlock(String body, int end) {}

    private static MediaBlock phoneBlock(String css) {
        Matcher m = Pattern.compile("@media\\s*\\(max-width:\\s*760px\\)\\s*\\{").matcher(css);
        assertTrue(m.find(), "zhiqu-ui.css 里找不到 @media (max-width: 760px) —— 断点改了？");
        int depth = 1, i = m.end();
        for (; i < css.length() && depth > 0; i++) {
            if (css.charAt(i) == '{') depth++;
            else if (css.charAt(i) == '}') depth--;
        }
        assertEquals(0, depth, "@media (max-width: 760px) 的花括号没配上");
        return new MediaBlock(css.substring(m.end(), i - 1), i);
    }

    @Test
    @DisplayName("网格一处都不内联（第八十一轮看板的最后两处挪进了类），手机样式里也不再有按 style 字面认元素的规则；看板的网格在手机上怎么排写在类名上")
    void 网格都在样式表里() throws IOException {
        // 第八十一轮之前这条是「每一种内联 grid-template-columns 在手机上怎么排都有人决定过」：手机段有两条按 [style*="…"] 认网格的规则
        // （一般的压成一栏、repeat(4..6 两个一排），这里一种一种对。最后两处（看板的四个数、左右两栏）挪进类以后它们没人用了，删掉；
        // 再内联一个网格，手机上就没人管它 —— 所以现在是一处都不许有
        List<Path> files = new ArrayList<>();
        try (Stream<Path> s = Files.list(STATIC)) {
            s.filter(p -> p.toString().endsWith(".html")).sorted().forEach(files::add);
        }
        try (Stream<Path> s = Files.walk(STATIC.resolve("assets"))) {
            s.filter(p -> p.toString().endsWith(".js") && !p.toString().contains("/vendor/")).sorted().forEach(files::add);
        }
        assertTrue(files.size() >= 25, "只扫到 " + files.size() + " 个文件 —— 扫空了？");
        Pattern inlineGrid = Pattern.compile("style=\\\\?[\"'][^\"']*grid-template-columns");
        List<String> found = new ArrayList<>();
        for (Path f : files) {
            String src = Files.readString(f, StandardCharsets.UTF_8);
            src = f.toString().endsWith(".js") ? SourceText.stripComments(src) : stripHtmlComments(src);
            if (inlineGrid.matcher(src).find()) found.add(STATIC.relativize(f).toString());
        }
        assertTrue(found.isEmpty(), "又内联了网格：" + found + " —— 写进 zhiqu-ui.css 的类，手机上怎么排写在类名上（zq-phone-1col / zq-phone-2col）");
        String block = phoneBlock(css()).body();
        assertFalse(block.contains("[style*="), "手机样式里又有按 style 字面认元素的规则 —— 内联的写法一改它就悄悄失效，改成认类");
        String dash = stripHtmlComments(Files.readString(STATIC.resolve("dashboard.html"), StandardCharsets.UTF_8));
        assertTrue(dash.contains("<section class=\"zq-grid zq-stat-grid zq-phone-2col\">"), "看板的四个数：手机上两个一排");
        assertTrue(dash.contains("<div class=\"zq-dash-cols zq-phone-1col\">"), "看板的左右两栏：手机上一栏");
        assertTrue(css().replace(" ", "").contains(".zq-dash-cols{display:grid;grid-template-columns:minmax(0,1fr)300px;"), "样式表里看板的两栏不是「正文 + 300 的右栏」");
    }

    @Test
    @DisplayName("设置 / 成就弹窗里的网格（第七十五轮起都是样式表里的类）：settings.js 不再内联网格；每一种在手机上怎么排写在类名上，和样式表一致")
    void 弹窗里的网格() throws IOException {
        String js = SourceText.stripComments(Files.readString(STATIC.resolve("assets/settings.js"), StandardCharsets.UTF_8));
        // 弹窗不在 .zq-main 里，正文那两条按 style 认的手机规则管不到这里；第七十五轮之前这条判扫的是内联的 grid-template-columns
        assertFalse(js.contains("grid-template-columns"), "settings.js 又内联了网格 —— 写进样式表的类，手机上怎么排写在类名上（zq-phone-1col / zq-phone-2col）");
        String css = css().replace(" ", "");
        // [网格的类, 样式表里那个类的列, 手机上：zq-phone-1col / zq-phone-2col / 空 = 自己按宽度排（auto-fill）]
        String[][] grids = {
                {"zq-set-grid", "grid-template-columns:repeat(2,minmax(0,1fr))", "zq-phone-1col"},
                {"zq-set-tiles", "grid-template-columns:repeat(4,minmax(0,1fr))", "zq-phone-2col"},
                {"zq-stat-grid", "grid-template-columns:repeat(4,minmax(0,1fr))", "zq-phone-2col"},
                {"zq-ach-list", "grid-template-columns:repeat(auto-fill,minmax(240px,1fr))", ""},
        };
        Pattern classAttr = Pattern.compile("class=\"([^\"]*)\"");
        List<String> wrong = new ArrayList<>();
        for (String[] g : grids) {
            Matcher rule = Pattern.compile("\\n\\." + g[0] + "\\{([^}]*)\\}").matcher(css);
            if (!rule.find() || !rule.group(1).contains(g[1])) wrong.add("样式表里 ." + g[0] + " 不是「" + g[1] + "」");
            int used = 0;
            Matcher cm = classAttr.matcher(js);
            while (cm.find()) {
                List<String> classes = List.of(cm.group(1).trim().split("\\s+"));
                if (!classes.contains(g[0])) continue;
                used++;
                boolean one = classes.contains("zq-phone-1col"), two = classes.contains("zq-phone-2col");
                boolean ok = g[2].isEmpty() ? !one && !two : classes.contains(g[2]) && !(one && two);
                if (!ok) wrong.add("." + g[0] + " 手机上应当" + (g[2].isEmpty() ? "自己按宽度排（不带 zq-phone-*）" : "带 " + g[2]) + "，类名是 " + classes);
            }
            if (used == 0) wrong.add("settings.js 里没扫到 ." + g[0] + " —— 改名了？这条判据就空转了");
        }
        assertTrue(wrong.isEmpty(), String.join("\n", wrong));
        String block = phoneBlock(css()).body().replace(" ", "");
        assertTrue(block.contains(".zq-phone-1col{grid-template-columns:minmax(0,1fr)!important;}")
                        && block.contains(".zq-phone-2col{grid-template-columns:repeat(2,minmax(0,1fr))!important;}"),
                "手机样式段里没有 zq-phone-1col / zq-phone-2col 这两条 —— 类名写了也不起作用");
    }

    @Test
    @DisplayName("手机样式段在 zhiqu-ui.css 的最后（@media 不加优先级：夹在中间时后面的 .zq-main 压过它，展开侧栏就把正文推到 188px）")
    void 手机样式段在文件最后() throws IOException {
        String css = css();
        MediaBlock b = phoneBlock(css);
        String after = css.substring(b.end()).trim();
        assertTrue(after.isEmpty(), "@media (max-width: 760px) 后面还有规则：" + after.substring(0, Math.min(120, after.length()))
                + " —— 同优先级时后面的赢，手机上的覆盖会被它压掉。新规则加在这段前面。");
        assertTrue(b.body().contains(".zq-main,.zq-main.is-side-collapsed{margin-left:56px"),
                "手机上正文的左边距不是写给 .zq-main 本身的 —— 只写 .is-side-collapsed 时，一展开侧栏正文就被推开");
    }

    @Test
    @DisplayName("断点只有一个：zhiqu-ui.js 判断手机用的媒体查询和样式表里的一字不差")
    void 断点一处() throws IOException {
        Matcher m = Pattern.compile("MOBILE_QUERY\\s*=\\s*'([^']+)'").matcher(uiJs());
        assertTrue(m.find(), "zhiqu-ui.js 里找不到 MOBILE_QUERY");
        Matcher c = Pattern.compile("@media\\s*(\\([^)]*\\))\\s*\\{").matcher(css());
        List<String> queries = new ArrayList<>();
        while (c.find()) queries.add(c.group(1));
        assertTrue(queries.contains(m.group(1)),
                "zhiqu-ui.js 的 MOBILE_QUERY「" + m.group(1) + "」和样式表里的 @media " + queries + " 对不上 —— "
                        + "侧栏 / 面板会在一种宽度下按手机收起、样式却按桌面排");
    }

    @Test
    @DisplayName("两侧可收起的面板：手机上默认收起、展开是临时的（不写桌面偏好）、宿主类由 JS 加上")
    void 面板在手机上() throws IOException {
        String js = uiJs();
        int a = js.indexOf("function makeCollapsible(");
        int b = js.indexOf("function setupPanels(");
        assertTrue(a >= 0 && b > a, "zhiqu-ui.js 里找不到 makeCollapsible / setupPanels");
        String make = js.substring(a, b);
        String setup = js.substring(b, js.indexOf("\n  }", b));
        // 两处：打开页面时一次，转屏 / 拖窗口跨过断点时一次。只数「出现过」的话删掉其中一处照样绿（扰动照出来的）
        // 第六十四轮初始化和断点切换改为 instant=true，避免进入页面时先播放收起动画；判据仍要求两处都以手机状态决定。
        int calls = make.split(Pattern.quote("set(isMobile() || remembered(),true)"), -1).length - 1;
        assertEquals(2, calls, "手机上面板没有默认收起（打开页面时、跨过断点时各一处，现在 " + calls + " 处）—— "
                + "桌面上记住的「展开」会在手机上把正文挤到 30px");
        assertTrue(make.contains("if(!isMobile()) lss(opts.key"), "手机上的展开 / 收起写进了桌面偏好");
        assertTrue(setup.contains("classList.add('zq-panel-host')"), "setupPanels 没给面板的父元素加 zq-panel-host —— 手机样式认不出这一排面板");
        assertTrue(css().contains(".zq-panel-host>[data-zq-collapse]:not(.zq-collapsed),.zq-panel-host>[data-zq-collapse].zq-panel-closing{position:absolute!important"),
                "手机上展开的面板没有浮在正文上面");
    }

    @Test
    @DisplayName("AI 助手、Wiki 的定高容器（.zq-fill-page）：有下限（200% 放大时 AI 对话区原来 40px、Wiki 正文区 52px），手机样式认的是同一个类")
    void 定高容器有下限() throws IOException {
        // 第七十八轮起两页的包裹是同一个类 .zq-fill-page（原来是两页各自的内联，手机段按 [style*="calc(100vh - 110px)"] 认）
        int pages = 0;
        for (String page : new String[]{"ai-assistant.html", "knowledge-wiki.html"}) {
            String html = stripHtmlComments(Files.readString(STATIC.resolve(page), StandardCharsets.UTF_8));
            assertTrue(html.matches("(?s).*<main class=\"zq-main\">\\s*<div class=\"zq-fill-page\">.*"),
                    page + " 的定高容器不是 .zq-main 下面第一层的 .zq-fill-page —— 手机段那条（.zq-main>.zq-fill-page）认不出它");
            assertFalse(html.contains("calc(100vh"), page + " 又在内联里写了定高");
            pages++;
        }
        assertEquals(2, pages);
        Matcher fill = Pattern.compile("\\n\\.zq-fill-page\\{([^}]*)\\}").matcher(css());
        assertTrue(fill.find(), "样式表里没有 .zq-fill-page");
        String style = fill.group(1);
        // 减的就是 .zq-main 桌面上的上下 padding（照样子写同一个令牌）：原来写死 110px（上 30 + 下 80），上边距换成 --zq-sp-7（32px）以后
        // 整页比窗口高 2px，点进表格的一格整页往上跳 2px（第八十五轮 review，桌面应用里）
        Matcher main = Pattern.compile("\\n\\.zq-main\\{[^}]*padding:(var\\([^)]*\\)|\\S+) (?:var\\([^)]*\\)|\\S+) ([^;]+);").matcher(css());
        assertTrue(main.find(), "样式表里找不到 .zq-main 的 padding");
        String expected = "height:calc(100vh - " + main.group(1) + " - " + main.group(2) + ")";
        assertTrue(style.contains(expected), ".zq-fill-page 的定高没减 .zq-main 的上下 padding（应当是 " + expected + "）：" + style);
        assertTrue(Pattern.compile("min-height:\\s*\\d{3}px").matcher(style).find(),
                ".zq-fill-page 没有下限：视口矮（放大 200%、手机横屏）时对话区 / 正文区会被压到几十像素");
        assertTrue(phoneBlock(css()).body().contains(".zq-main>.zq-fill-page{height:calc(100dvh - 82px)"),
                "手机段里没有按实际 padding 重算定高");
    }

    @Test
    @DisplayName("KaTeX 给读屏的那份 MathML 挂在公式上（否则长页面里的公式把定高的 Wiki 整页撑到它那儿）")
    void 公式不撑整页() throws IOException {
        assertTrue(css().contains(".katex{position:relative;}"), "zhiqu-ui.css 没有 .katex{position:relative}");
    }

    /** needle 前面最近的那个 class=" 里的类，和样式表里这些类的声明（第八十一轮起看板的样子都在类上）。 */
    private static String rulesBefore(String code, String needle) throws IOException {
        int at = code.indexOf(needle);
        assertTrue(at >= 0, "找不到 " + needle);
        int c = code.lastIndexOf("class=\"", at);
        assertTrue(c >= 0, needle + " 前面没有 class");
        String css = css();
        StringBuilder out = new StringBuilder();
        for (String cls : code.substring(c + 7, code.indexOf('"', c + 7)).trim().split("\\s+")) {
            Matcher m = Pattern.compile("(?:^|[},])\\s*[^{}]*\\." + Pattern.quote(cls) + "(?![\\w-])[^{}]*\\{([^}]*)\\}", Pattern.MULTILINE).matcher(css);
            while (m.find()) out.append(m.group(1)).append(';');
        }
        return out.toString();
    }

    private static String fn(String code, String signature) {
        int a = code.indexOf(signature);
        assertTrue(a >= 0, "找不到 " + signature);
        int b = code.indexOf("\n  function ", a + signature.length());
        return code.substring(a, b < 0 ? code.length() : b);
    }

    @Test
    @DisplayName("看板列表里的用户原文要收住（原来整段说明原样摊开：5462 字的说明在 375px 上 5000px 高，桌面上也有 1140px）")
    void 看板列表收住原文() throws IOException {
        // 第三十五轮起看板是模块（pages/dashboard.js）；第八十一轮起收住的样子在类上（原来是每处内联的 -webkit-line-clamp）
        String api = SourceText.pageModule("dashboard.js");
        String today = SourceText.functionBody(api, "function renderToday(");
        assertTrue(rulesBefore(today, "esc(x.title)").contains("-webkit-line-clamp:2"), "「今天」的标题没有限行");
        String desc = rulesBefore(today, "esc(x.description");
        assertTrue(desc.contains("text-overflow:ellipsis") && desc.contains("white-space:nowrap"), "「今天」的说明没有收成一行");
        assertTrue(rulesBefore(SourceText.functionBody(api, "function renderQuadrants("), "esc(x.title)").contains("-webkit-line-clamp:2"), "象限摘要的标题没有限行");
        assertTrue(rulesBefore(SourceText.functionBody(api, "function renderDeadlines("), "esc(d.title)").contains("-webkit-line-clamp:2"), "临近 DDL 的标题没有限行");
    }

    @Test
    @DisplayName("长得像按钮的链接也不折行（「回到看板」原来在手机上被挤成两行，有了 overflow-wrap:anywhere 还会从词中间断）")
    void 按钮不折行() throws IOException {
        Matcher m = Pattern.compile("([^{}]+)\\{([^{}]*white-space:nowrap[^{}]*)\\}").matcher(css());
        boolean found = false;
        while (m.find()) {
            List<String> sels = List.of(m.group(1).trim().split("\\s*,\\s*"));
            if (sels.contains(".zq-btn") && sels.contains(".zq-btn-ghost")) found = true;
        }
        assertTrue(found, "没有一条把 .zq-btn / .zq-btn-ghost 设成 white-space:nowrap 的规则");
        // AI 输入区：原来输入框和六个按钮挤在一排，手机上靠这里把输入框挪到单独一行（它的 min-width:200px 在 320px 宽时伸出去 23px）。
        // 第四十四轮起输入框本来就单独一行（AiComposerTest 管结构），手机上要管的是底下工具那一条：三个开关只留图标，不然发送键被挤出框外
        String block = phoneBlock(css()).body();
        assertTrue(block.contains(".zq-chip-label{display:none;}"),
                "手机上 AI 输入区的三个开关还带着字 —— 375px 宽时工具那一条放不下，发送键被挤出框外");
    }
}
