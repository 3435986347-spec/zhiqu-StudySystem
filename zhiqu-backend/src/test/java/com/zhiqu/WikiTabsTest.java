package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 知识 Wiki 的标签页与前进 / 返回。
 *
 * <p>行为判据跑在 node 上（{@code src/test/resources/js/wiki-tabs-check.js}），直接加载
 * {@code assets/pages/knowledge-wiki.js} 里发布的那份实现 —— 在 Java 里重写一份状态机就成了
 * 「测试一个副本」。链接手势另由 Node 直接运行发布的事件处理器；Java 侧核对页面容器和入口。
 */
class WikiTabsTest {

    private static final Path HARNESS = Path.of("src/test/resources/js/wiki-tabs-check.js");
    private static final Path WIKI_HTML = Path.of("src/main/resources/static/knowledge-wiki.html");
    private static final Path CSS = Path.of("src/main/resources/static/assets/zhiqu-ui.css");
    /** 第三十六轮起知识 Wiki 是模块：标签页那一段住在这里（wiki-tabs-check.js 也从这里抠）。 */
    private static final Path WIKI_JS = Path.of("src/main/resources/static/assets/pages/knowledge-wiki.js");

    @Test
    @DisplayName("标签页与前进/返回的行为判据必须全绿")
    void 行为判据必须全绿() throws Exception {
        NodeRunner.run(HARNESS, WIKI_JS);
    }

    @Test
    @DisplayName("页面上要有标签栏容器与前进/返回按钮 —— 少一个，对应的 JS 就静默失效")
    void 页面要有对应的容器() throws Exception {
        String html = Files.readString(WIKI_HTML, StandardCharsets.UTF_8);
        for (String id : List.of("zq-wiki-tabs", "zq-wiki-back", "zq-wiki-fwd")) {
            assertTrue(html.contains("id=\"" + id + "\""),
                    "knowledge-wiki.html 里缺少 #" + id + "。JS 那边是 "
                            + "`var bar = $('#...'); if (!bar) return;` —— 缺了不报错，只是不工作。");
        }
    }

    /**
     * 「重绘当前页」的调用点要带 {@code history: true}。
     *
     * <p><b>这一条是约定，不是护栏 —— 理由以扰动结果为准。</b>写它的时候以为：漏了参数，
     * 返回栈就会堆满同一页，用户连点返回在原地打转。扰动一跑，把参数去掉历史栈纹丝不动 ——
     * 因为 {@code trackWikiNavigation} 里还有一个 {@code tab.id !== id}，
     * 同一页再打开一次本来就不记。真正承重的是那个判断，由 node 侧的
     * 「重复打开同一页不压历史」钉着。
     *
     * <p>那这条还留着做什么：它让调用点自己说清「这不是一次跳转」。哪天有人动了
     * {@code tab.id !== id}（比如为了支持同页锚点跳转），这些地方才不会一起塌 ——
     * 一道防御深度，不是唯一那道。理由写错会误导下一个改这段代码的人，所以照实写。
     */
    @Test
    @DisplayName("重绘类的调用点要带 history:true（防御深度，承重的是 id 比较）")
    void 重绘不得压历史栈() throws Exception {
        String js = SourceText.pageModule("knowledge-wiki.js");

        // 先给「看到了多少」定个正下限：一个都没扫到的话下面是真空通过。
        Matcher all = Pattern.compile("paintWikiDoc\\(").matcher(js);
        int calls = 0;
        while (all.find()) calls++;
        assertTrue(calls >= 10, "只扫到 " + calls + " 处 paintWikiDoc 调用 —— 扫空或扫漏了");

        // 两处重绘，各自的形状不一样，所以分开断言 —— 写一个「就近找最近的
        // paintWikiDoc」的通用检查看着更聪明，实际会抓到隔壁那次调用（第一版就是这样红的）。

        // 第八十三轮：自动保存不重画（原来存完重画阅读视图，正在改的那段跳 33px）；「取消」没了。
        // 剩下的同一页重绘是「载入别处的版本」：重绘的是当前页，不能压进返回栈（压了「返回」原地打转 —— 不报错，只是按钮看起来坏了）
        assertFalse(SourceText.functionBody(js, "function saveWikiContent(p, md)").contains("paintWikiDoc("), "自动保存又重画了整页");
        assertTrue(SourceText.functionBody(js, "function resolveWikiConflictTheirs(p)").contains("paintWikiDoc(p, { history: true })"),
                "「载入别处的版本」那次重绘没带 history:true，同一页会压进返回栈");
    }

    @Test
    @DisplayName("目录项与双链都要支持 ⌘/Ctrl+点击开新标签")
    void 打开入口要支持新标签() throws Exception {
        String js = SourceText.pageModule("knowledge-wiki.js");
        assertTrue(js.contains("newTab: e.metaKey || e.ctrlKey"),
                "目录项没有把 ⌘/Ctrl+点击作为新标签打开手势");
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/wiki-link-routing-check.js"), WIKI_JS),
                "正文 [[双链]] 的点击手势没有正确路由到标签页");
    }

    /**
     * 文档标题要和正文左边缘落在同一条竖线上。
     *
     * <p>第一版把前进/返回按钮放进了标题行，两个按钮把「文档视图 / 标题」整体往右推了
     * <b>76px</b>（实测 373 vs 正文 297）—— 标题比它自己的正文缩进得明显更多，
     * 一眼就能看出来别扭。现在按钮移到了上面那条工具条里（和浏览器一样），
     * 标题回到 26px 这条线上。
     *
     * <p>这条对齐由两个分散的数字维持：标题行的 {@code padding-left} 和
     * {@code #zq-doc} 的 {@code padding-left}。改一个不改另一个不会报错，
     * 只会又错开 —— 而错开几像素这种事没人在代码评审里看得出来。
     */
    @Test
    @DisplayName("文档标题与正文的左边缘要对齐")
    void 标题与正文左边缘要对齐() throws Exception {
        // 第七十九轮起两个数都在样式表里（原来在 knowledge-wiki.html 的内联）：标题行是 .zq-wiki-head，正文是 #zq-doc
        String html = Files.readString(WIKI_HTML, StandardCharsets.UTF_8);
        assertTrue(html.contains("<div class=\"zq-wiki-head\">") && html.indexOf("id=\"zq-doc-title\"") > html.indexOf("<div class=\"zq-wiki-head\">"),
                "标题不在 .zq-wiki-head 那一行里了");
        assertTrue(html.contains("<div id=\"zq-doc\" class=\"zq-prose\"></div>"), "#zq-doc 又写了内联样式（左内边距要和标题行一起在样式表里改）");
        String css = Files.readString(CSS, StandardCharsets.UTF_8);
        int headerLeft = paddingSide(rule(css, ".zq-wiki-head"), 3);
        int docLeft = paddingSide(rule(css, "#zq-doc"), 3);

        assertEquals(docLeft, headerLeft,
                "标题行的左内边距是 " + headerLeft + "px，正文是 " + docLeft
                        + "px —— 标题会比它自己的正文缩进得多或少。");

    }

    /**
     * 第一个标签要从知识页<b>卡片</b>的左边缘开始 —— 标签栏不留左内边距。
     *
     * <p>返工了两次，每次都对齐错了对象：14px 让标签文字对正文文字，26px 让标签方框对正文文字。
     * 两次都在对齐卡片<b>里面</b>的正文，而用户说的「下面的知识页」是卡片本身 ——
     * 26px 时实测卡片边缘 436、第一个标签 463，中间 27px 灰带就是那条「没对齐」，
     * 用户为此提了三次。标签只有右边框，所以任何左内边距都会在卡片边缘和第一个标签之间
     * 留出一截空着的灰带。
     *
     * <p>这一条和上一条（标题对正文）不冲突：标签贴卡片边、内容内缩，是浏览器的版式。
     */
    @Test
    @DisplayName("第一个标签贴着知识页卡片的左边缘（标签栏 padding-left 为 0）")
    void 第一个标签贴卡片左边缘() throws Exception {
        String html = Files.readString(WIKI_HTML, StandardCharsets.UTF_8);
        assertTrue(html.contains("<div id=\"zq-wiki-tabs\"></div>"), "标签栏又写了内联样式");
        int barLeft = pxAfter(rule(Files.readString(CSS, StandardCharsets.UTF_8), "#zq-wiki-tabs"), "", "padding-left:");
        assertEquals(0, barLeft,
                "标签栏左内边距是 " + barLeft + "px —— 卡片边缘和第一个标签之间会空出一截灰带。"
                        + "用户要的是标签贴着知识页卡片的左边，不是对齐卡片里的正文（这条已经返工两次）。");
    }

    /**
     * 前进/返回按钮必须留在工具条里，不能回到标题行。
     *
     * <p>放回标题行会把标题整体右推 76px（实测 373 vs 正文 297）—— 上一条判据只量内边距，
     * 量不到「有没有别的元素挤在标题前面」，所以这条单独看结构。
     *
     * <p>按钮在工具条内部是在标签左边还是右边，这条不管 —— 那是排版偏好；
     * 「在不在标题行里」才是会破坏对齐的那件事。
     */
    @Test
    @DisplayName("前进/返回按钮要留在工具条里，不能挤进标题行")
    void 导航按钮不得挤在标题前() throws Exception {
        String html = Files.readString(WIKI_HTML, StandardCharsets.UTF_8);
        int titleRow = html.indexOf("<div class=\"zq-wiki-head\">");
        int title = html.indexOf("id=\"zq-doc-title\"");
        assertTrue(titleRow >= 0 && title > titleRow, "定位不到标题行 —— 判据扫空了");
        assertTrue(html.contains("id=\"zq-wiki-back\"") && html.contains("id=\"zq-wiki-fwd\""),
                "两个导航按钮要都在");

        String headerRow = html.substring(titleRow, title);
        assertFalse(headerRow.contains("id=\"zq-wiki-back\"") || headerRow.contains("id=\"zq-wiki-fwd\""),
                "导航按钮出现在标题行里，标题会被整体右推：" + headerRow);
    }

    @Test
    @DisplayName("localStorage 的读写都必须包在 try/catch 里")
    void 存储访问必须有兜底() throws Exception {
        String js = Files.readString(WIKI_JS, StandardCharsets.UTF_8);
        int at = js.indexOf("function saveWikiTabs()");
        assertTrue(at >= 0, "找不到 saveWikiTabs —— 判据扫空了");
        String block = js.substring(at, Math.min(js.length(), at + 1800));
        assertTrue(block.contains("function loadWikiTabs()"), "截取的范围没覆盖到 loadWikiTabs");

        // 隐私模式下 localStorage 的存取会直接抛，没兜底就是整页白屏
        assertFalse(block.replaceAll("(?s)try \\{.*?\\}", "").contains("localStorage."),
                "有 localStorage 访问不在 try 块里。隐私模式下它会抛异常，"
                        + "而这只是个便利功能，不该让整个 Wiki 打不开。");
    }

    /**
     * 在 {@code anchor} 之后找 {@code prefix}，读紧跟其后的像素值。
     *
     * <p>要求两段都能找到 —— 找不到就是结构变了，此时必须红，而不是拿一个默认值糊过去：
     * 「没找到」和「找到了且对齐」在断言里长得一样，这正是空扫假绿的来源。
     */
    /** 样式表里某个选择器（整条、只有它自己）的声明 */
    private static String rule(String css, String selector) {
        Matcher m = Pattern.compile("(?m)^" + Pattern.quote(selector) + "\\{([^}]*)\\}").matcher(css);
        assertTrue(m.find(), "样式表里没有 " + selector);
        String body = m.group(1);
        assertFalse(m.find(), selector + " 在样式表里写了不止一处 —— 只读第一处会漏掉后面那条");
        return body;
    }

    /** padding 简写里某一边的像素数（0 上、1 右、2 下、3 左；按 CSS 的一到四个值展开） */
    private static int paddingSide(String declarations, int side) {
        Matcher m = Pattern.compile("(?:^|;)padding:([^;]+)").matcher(declarations);
        assertTrue(m.find(), "没有 padding 简写：" + declarations);
        String[] v = m.group(1).trim().split("\\s+");
        String[] four = switch (v.length) {
            case 1 -> new String[]{v[0], v[0], v[0], v[0]};
            case 2 -> new String[]{v[0], v[1], v[0], v[1]};
            case 3 -> new String[]{v[0], v[1], v[2], v[1]};
            default -> v;
        };
        return Integer.parseInt(four[side].replace("px", ""));
    }

    private static int pxAfter(String text, String anchor, String prefix) {
        int at = text.indexOf(anchor);
        assertTrue(at >= 0, "找不到锚点「" + anchor + "」—— 判据扫空了");
        int p = text.indexOf(prefix, at);
        assertTrue(p >= 0, "锚点「" + anchor + "」之后找不到「" + prefix + "」—— 样式被改写了");
        int start = p + prefix.length();
        int end = start;
        while (end < text.length() && Character.isDigit(text.charAt(end))) end++;
        assertTrue(end > start, "「" + prefix + "」后面不是数字");
        return Integer.parseInt(text.substring(start, end));
    }
}
