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
 * {@code assets/zhiqu-api.js} 里发布的那份实现 —— 在 Java 里重写一份状态机就成了
 * 「测试一个副本」。这里的 Java 判据只管两件 node 侧看不到的事：<b>每个打开入口有没有
 * 用对 opts</b>，以及页面上那几个容器还在不在。
 */
class WikiTabsTest {

    private static final Path HARNESS = Path.of("src/test/resources/js/wiki-tabs-check.js");
    private static final Path WIKI_HTML = Path.of("src/main/resources/static/knowledge-wiki.html");

    @Test
    @DisplayName("标签页与前进/返回的行为判据必须全绿")
    void 行为判据必须全绿() throws Exception {
        NodeRunner.run(HARNESS, NodeRunner.API_JS);
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
        String js = SourceText.stripComments(
                Files.readString(NodeRunner.API_JS, StandardCharsets.UTF_8));

        // 先给「看到了多少」定个正下限：一个都没扫到的话下面是真空通过。
        Matcher all = Pattern.compile("paintWikiDoc\\(").matcher(js);
        int calls = 0;
        while (all.find()) calls++;
        assertTrue(calls >= 10, "只扫到 " + calls + " 处 paintWikiDoc 调用 —— 扫空或扫漏了");

        // 两处重绘，各自的形状不一样，所以分开断言 —— 写一个「就近找最近的
        // paintWikiDoc」的通用检查看着更聪明，实际会抓到隔壁那次调用（第一版就是这样红的）。

        assertTrue(js.contains("paintWikiDoc(state.wikiCur, { history: true })"),
                "取消编辑那次重绘没带 history:true。它重绘的是当前页，压进返回栈"
                        + "会让「返回」原地打转 —— 不报错，只是按钮看起来坏了。");

        // 锚点必须是 saveWikiEdit 这个函数本身。第一版锚在 toast('已保存') 上，
        // 而那句话在文件里出现好几次 —— 抓到的是共享计划后台那一处，报错里贴出来的
        // 上下文全是 /admin/shared-plans。锚点不唯一的判据，红绿都不可信。
        int fn = js.indexOf("function saveWikiEdit()");
        assertTrue(fn >= 0, "找不到 saveWikiEdit —— 判据扫空了");
        int fnEnd = js.indexOf("\n  }", fn);
        assertTrue(fnEnd > fn, "截不出 saveWikiEdit 的函数体");
        String saveBody = js.substring(fn, fnEnd);
        assertTrue(saveBody.contains("paintWikiDoc("),
                "saveWikiEdit 里没有 paintWikiDoc 调用 —— 抠错范围了：" + saveBody);
        assertTrue(saveBody.contains("paintWikiDoc(p, { history: true })"),
                "保存后那次重绘没带 history:true。保存前后是同一页，"
                        + "压栈会让返回栈里堆满重复项。函数体：" + saveBody);
    }

    @Test
    @DisplayName("目录项与双链都要支持 ⌘/Ctrl+点击开新标签")
    void 打开入口要支持新标签() throws Exception {
        String js = SourceText.stripComments(
                Files.readString(NodeRunner.API_JS, StandardCharsets.UTF_8));
        assertTrue(js.contains("newTab: e.metaKey || e.ctrlKey"),
                "没有一处支持 ⌘/Ctrl+点击开新标签 —— 有标签栏却只能从 + 按钮开，"
                        + "等于少了最常用的那个手势");

        Matcher m = Pattern.compile("newTab: e\\.metaKey \\|\\| e\\.ctrlKey").matcher(js);
        int n = 0;
        while (m.find()) n++;
        assertTrue(n >= 2,
                "只有 " + n + " 处支持 ⌘/Ctrl+点击。目录项和正文里的 [[双链]] 都要支持 —— "
                        + "只做一半的话用户会以为另一处坏了。");
    }

    /**
     * 标签文字、返回按钮、正文三条左边缘要落在同一条线上。
     *
     * <p>这条对齐由<b>三个分散的数字相加</b>而成：标签栏的 padding-left（HTML）
     * + 单个标签的 padding-left（JS 里拼的行内样式）== 正文的 padding-left（HTML）
     * == 标题行的 padding-left（HTML）。改其中任何一个都会错位，而错位 6px
     * 这种程度不会有人在代码评审里看出来 —— 只有量一下才知道。
     */
    @Test
    @DisplayName("标签文字 / 返回按钮 / 正文 三条左边缘要对齐")
    void 三条左边缘要对齐() throws Exception {
        String html = Files.readString(WIKI_HTML, StandardCharsets.UTF_8);
        String js = Files.readString(NodeRunner.API_JS, StandardCharsets.UTF_8);

        int barLeft = pxAfter(html, "id=\"zq-wiki-tabs\"", "padding:0 8px 0 ");
        int tabLeft = pxAfter(js, "data-wiki-tab=\"' + i + '\"", "padding:7px 8px 7px ");
        int docLeft = pxAfter(html, "id=\"zq-doc\"", "padding:22px ");
        int headerLeft = pxAfter(html, "padding:14px 20px 14px ", "padding:14px 20px 14px ");

        assertEquals(docLeft, barLeft + tabLeft,
                "标签文字的左边缘（标签栏 " + barLeft + "px + 标签自身 " + tabLeft
                        + "px = " + (barLeft + tabLeft) + "px）和正文的 " + docLeft + "px 对不齐");
        assertEquals(docLeft, headerLeft,
                "标题行的左内边距 " + headerLeft + "px 和正文的 " + docLeft + "px 对不齐，"
                        + "返回按钮会比正文缩进得少");
    }

    @Test
    @DisplayName("localStorage 的读写都必须包在 try/catch 里")
    void 存储访问必须有兜底() throws Exception {
        String js = Files.readString(NodeRunner.API_JS, StandardCharsets.UTF_8);
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
