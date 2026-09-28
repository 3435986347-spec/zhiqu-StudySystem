package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
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

    enum Phone { ONE_COLUMN, TWO_COLUMNS, KEEP }

    /**
     * 每一种内联 grid-template-columns 在手机上怎么排 —— 人决定过的。键是去掉空白的值。
     * KEEP 的那些要么本来就窄（「时间 + 标题」一行），要么放在自己会横向滚动的框里（一周日历、任务表），要么 auto-fit 自己会换行。
     */
    private static final Map<String, Phone> DECISIONS = new LinkedHashMap<>();
    static {
        // 并排的两栏 / 三栏卡片：手机上一栏
        for (String v : new String[]{"1fr", "1fr1fr", "repeat(2,minmax(0,1fr))", "minmax(0,1fr)minmax(0,1fr)",
                "repeat(3,minmax(0,1fr))", "minmax(300px,1fr)minmax(0,1.5fr)", "minmax(0,1fr)300px", "300pxminmax(0,1fr)",
                "minmax(0,1.7fr)minmax(280px,1fr)", "minmax(0,1.6fr)minmax(300px,1fr)", "minmax(0,1.2fr)minmax(280px,1fr)"}) {
            DECISIONS.put(v, Phone.ONE_COLUMN);
        }
        // 四到六个一排的数字卡：两个一排
        for (String v : new String[]{"repeat(4,minmax(0,1fr))", "repeat(5,minmax(0,1fr))", "repeat(6,minmax(0,1fr))"}) {
            DECISIONS.put(v, Phone.TWO_COLUMNS);
        }
        // 不动
        DECISIONS.put("52pxminmax(0,1fr)auto", Phone.KEEP);            // 看板「今天」一行：时间 + 标题 + 按钮
        DECISIONS.put("36pxminmax(0,1fr)", Phone.KEEP);                 // 一周日历里的一条：时间 + 标题
        DECISIONS.put("repeat(7,minmax(108px,1fr))", Phone.KEEP);       // 一周日历：在自己的框里横向滚动
        DECISIONS.put("minmax(200px,2.2fr)104px64px78px118px118px108px", Phone.KEEP);        // 任务表一行
        DECISIONS.put("minmax(120px,1.1fr)minmax(150px,1.3fr)74px62px102px104px128px", Phone.KEEP); // 账号管理表一行
        DECISIONS.put("repeat(auto-fit,minmax(140px,1fr))", Phone.KEEP);
        DECISIONS.put("repeat(auto-fit,minmax(178px,1fr))", Phone.KEEP);
        DECISIONS.put("1fr1fr1fr", Phone.KEEP);                        // 个人中心三个小数字：240px 也放得下
    }

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

    /** 一条规则里所有 [style*="…"] 的字面。 */
    private static List<String> styleNeedles(String selector) {
        List<String> out = new ArrayList<>();
        Matcher m = Pattern.compile("\\[style\\*=\"([^\"]+)\"\\]").matcher(selector);
        while (m.find()) out.add(m.group(1));
        return out;
    }

    /** 手机样式真的会把这个内联 style 排成什么 —— 读的是 zhiqu-ui.css 里那两条规则本身，不是这里的一份抄写。 */
    private static Phone outcome(String block, String style) {
        String oneRule = null, twoRule = null;
        Matcher rule = Pattern.compile("([^{}]+)\\{([^{}]*)\\}").matcher(block);
        while (rule.find()) {
            String sel = rule.group(1), decl = rule.group(2).replace(" ", "");
            if (!sel.contains("[style*=")) continue;
            if (decl.contains("grid-template-columns:minmax(0,1fr)")) oneRule = sel;
            if (decl.contains("grid-template-columns:repeat(2,minmax(0,1fr))")) twoRule = sel;
        }
        assertTrue(oneRule != null && twoRule != null, "手机样式里找不到「压成一栏」或「两个一排」那条规则");
        for (String alt : twoRule.split(",")) {
            for (String needle : styleNeedles(alt)) if (style.contains(needle)) return Phone.TWO_COLUMNS;
        }
        String positive = oneRule.substring(0, oneRule.indexOf(":not("));
        List<String> must = styleNeedles(positive);
        List<String> mustNot = styleNeedles(oneRule.substring(positive.length()));
        assertTrue(!must.isEmpty() && mustNot.size() >= 5, "「压成一栏」那条规则解析不出来（扫空了）：" + oneRule);
        boolean applies = must.stream().allMatch(style::contains) && mustNot.stream().noneMatch(style::contains);
        return applies ? Phone.ONE_COLUMN : Phone.KEEP;
    }

    @Test
    @DisplayName("每一种内联 grid-template-columns 在手机上怎么排都有人决定过，而且 zhiqu-ui.css 真的那样排")
    void 每种网格在手机上怎么排都决定过() throws IOException {
        String block = phoneBlock(css()).body();
        List<Path> files = new ArrayList<>();
        try (Stream<Path> s = Files.list(STATIC)) {
            s.filter(p -> p.toString().endsWith(".html")).sorted().forEach(files::add);
        }
        files.add(STATIC.resolve("assets/zhiqu-api.js"));
        files.add(STATIC.resolve("assets/zhiqu-ui.js"));

        Pattern stylePat = Pattern.compile("style=\"([^\"]*grid-template-columns[^\"]*)\"");
        Pattern valuePat = Pattern.compile("grid-template-columns:\\s*([^;\"']+)");
        Map<String, String> undecided = new TreeMap<>();
        List<String> wrong = new ArrayList<>();
        int seen = 0;
        java.util.Set<String> distinct = new java.util.HashSet<>();
        for (Path f : files) {
            String src = Files.readString(f, StandardCharsets.UTF_8);
            src = f.toString().endsWith(".js") ? SourceText.stripComments(src) : stripHtmlComments(src);
            Matcher sm = stylePat.matcher(src);
            while (sm.find()) {
                String style = sm.group(1);
                Matcher vm = valuePat.matcher(style);
                if (!vm.find()) continue;
                String value = vm.group(1).trim();
                String key = value.replaceAll("\\s+", "");
                seen++;
                distinct.add(key);
                Phone want = DECISIONS.get(key);
                if (want == null) {
                    undecided.put(value, f.getFileName().toString());
                    continue;
                }
                Phone got = outcome(block, style);
                if (got != want) wrong.add(f.getFileName() + "「" + value + "」应当 " + want + "，zhiqu-ui.css 实际 " + got);
            }
        }
        assertTrue(seen >= 30 && distinct.size() >= 15,
                "只扫到 " + seen + " 处 / " + distinct.size() + " 种 grid-template-columns —— 扫描扫空了（style 的写法变了？），这时下面的判据全是空转");
        assertTrue(undecided.isEmpty(), "新的 grid-template-columns，还没决定它在手机上怎么排：" + undecided
                + "\n—— 在 MobileLayoutTest.DECISIONS 里写下一栏 / 两个一排 / 不动（不动的话它得本来就窄、或者在会横向滚动的框里），"
                + "再让 zhiqu-ui.css 的 @media (max-width: 760px) 真的那样排");
        assertTrue(wrong.isEmpty(), String.join("\n", wrong));
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
        int calls = make.split(Pattern.quote("set(isMobile() || remembered())"), -1).length - 1;
        assertEquals(2, calls, "手机上面板没有默认收起（打开页面时、跨过断点时各一处，现在 " + calls + " 处）—— "
                + "桌面上记住的「展开」会在手机上把正文挤到 30px");
        assertTrue(make.contains("if(!isMobile()) lss(opts.key"), "手机上的展开 / 收起写进了桌面偏好");
        assertTrue(setup.contains("classList.add('zq-panel-host')"), "setupPanels 没给面板的父元素加 zq-panel-host —— 手机样式认不出这一排面板");
        assertTrue(css().contains(".zq-panel-host>[data-zq-collapse]:not(.zq-collapsed){position:absolute!important"),
                "手机上展开的面板没有浮在正文上面");
    }

    @Test
    @DisplayName("AI 助手、Wiki 的定高容器：有下限（200% 放大时正文区原来是 0px），并且和手机样式认的是同一个字面")
    void 定高容器有下限() throws IOException {
        int pages = 0;
        for (String page : new String[]{"ai-assistant.html", "knowledge-wiki.html"}) {
            String html = stripHtmlComments(Files.readString(STATIC.resolve(page), StandardCharsets.UTF_8));
            Matcher m = Pattern.compile("style=\"([^\"]*height:calc\\(100vh[^\"]*)\"").matcher(html);
            assertTrue(m.find(), page + " 找不到定高容器");
            String style = m.group(1);
            assertTrue(style.contains("calc(100vh - 110px)"),
                    page + " 的定高不是 calc(100vh - 110px) 了 —— zhiqu-ui.css 手机段按这个字面把它换成 100dvh - 82px，字面一变那条就不生效");
            assertTrue(Pattern.compile("min-height:\\s*\\d{3}px").matcher(style).find(),
                    page + " 的定高容器没有下限：视口矮（放大 200%、手机横屏）时对话区 / 正文区会被压到几十像素");
            pages++;
        }
        assertEquals(2, pages);
        assertTrue(phoneBlock(css()).body().contains("[style*=\"calc(100vh - 110px)\"]{height:calc(100dvh - 82px)"),
                "手机段里没有按实际 padding 重算定高");
    }

    @Test
    @DisplayName("KaTeX 给读屏的那份 MathML 挂在公式上（否则长页面里的公式把定高的 Wiki 整页撑到它那儿）")
    void 公式不撑整页() throws IOException {
        assertTrue(css().contains(".katex{position:relative;}"), "zhiqu-ui.css 没有 .katex{position:relative}");
    }

    /** needle 前面最近的那个 style=" 里写了什么。 */
    private static String styleBefore(String code, String needle) {
        int at = code.indexOf(needle);
        assertTrue(at >= 0, "找不到 " + needle);
        int s = code.lastIndexOf("style=\"", at);
        assertTrue(s >= 0, needle + " 前面没有 style");
        return code.substring(s, at);
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
        String api = apiJs();
        String today = fn(api, "function renderToday(");
        assertTrue(styleBefore(today, "esc(x.title)").contains("-webkit-line-clamp"), "「今天」的标题没有限行");
        String desc = styleBefore(today, "esc(x.description");
        assertTrue(desc.contains("text-overflow:ellipsis") && desc.contains("white-space:nowrap"), "「今天」的说明没有收成一行");
        assertTrue(styleBefore(fn(api, "function renderQuadrants("), "esc(x.title)").contains("-webkit-line-clamp"), "象限摘要的标题没有限行");
        assertTrue(styleBefore(fn(api, "function renderDeadlines("), "esc(d.title)").contains("-webkit-line-clamp"), "临近 DDL 的标题没有限行");
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
        String block = phoneBlock(css()).body();
        assertTrue(block.contains("#zq-draft{order:-1;flex:1 1 100%!important;min-width:0!important;}"),
                "手机上 AI 输入框没有单独占一行（它的 min-width:200px 在 320px 宽时伸出去 23px）");
    }
}
