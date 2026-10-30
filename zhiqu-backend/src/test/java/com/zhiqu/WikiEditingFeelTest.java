package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 第八十三轮（docs/rounds/round-83.md）：用户「点不准、点了没反应、卡、上下跳」—— 照 Obsidian 改的几处里，靠浏览器排版才看得出来的，
 * 这里按源码钉住接线（效果在内置浏览器和桌面应用里用真鼠标量过，数字在轮次记录里）。
 */
class WikiEditingFeelTest {

    private static String code(String file) throws Exception {
        return SourceText.stripComments(Files.readString(Path.of("src/main/resources/static/assets").resolve(file), StandardCharsets.UTF_8));
    }

    @Test
    @DisplayName("工具栏的按钮按下去不抢正文的焦点（原来只有「图片」这样）：焦点一离开，光标那一行露出的 ## ** 藏起来、点完又露出来，闪一下，选区也丢")
    void 工具栏不抢焦点() throws Exception {
        String wiki = code("pages/knowledge-wiki.js");
        int wire = wiki.indexOf("$all('[data-wiki-cmd]', section).forEach(function (b) {");
        assertTrue(wire >= 0, "找不到工具栏按钮的接线");
        String body = wiki.substring(wire, wiki.indexOf("});", wire));
        assertTrue(body.contains("b.onmousedown = function (e) { e.preventDefault(); };"), "工具栏按钮按下去会抢走正文的焦点");
        assertFalse(body.contains("=== 'image') b.onmousedown"), "又只给「图片」一个按钮不抢焦点了");
    }

    @Test
    @DisplayName("点进画出来的表格 / 图片 / 公式：表格按点的那一格放光标（原来一律放到表格开头）；换回原文以后点的那一行留在鼠标底下（原来下面整块挪 16px）")
    void 点进画出来的块() throws Exception {
        String cm = code("wiki-cm.js");
        int widget = cm.indexOf("const RenderedWidget = class extends WidgetType {");
        String rendered = cm.substring(widget, cm.indexOf("};", cm.indexOf("ignoreEvent()", widget)));
        assertTrue(rendered.contains("placeKeepingPointer(view, view.posAtDOM(el) + this.source.length, el.getBoundingClientRect().top);"),
                "点图片换回原文以后没留在鼠标底下");
        // 第八十五轮起表格在格子里直接改；点表格边上（不在格子里）照旧换回原文，点的那一行留在鼠标底下
        String table = cm.substring(cm.indexOf("function wireTable("), cm.indexOf("const RenderedWidget = class extends WidgetType {"));
        assertTrue(table.contains("const at = tableStart(); if (at >= 0) placeKeepingPointer(view, at, el.getBoundingClientRect().top);"),
                "点表格边上换回原文以后没留在鼠标底下");
        int math = cm.indexOf("const MathWidget = class extends WidgetType {");
        String mathBody = cm.substring(math, cm.indexOf("const CheckboxWidget", math));
        assertTrue(mathBody.contains("placeKeepingPointer(view, at + (this.display ? 3 : 1), el.getBoundingClientRect().top);") && mathBody.contains("ignoreEvent() { return false; }"),
                "点画出来的公式又什么都不发生了");
        String keep = cm.substring(cm.indexOf("function placeKeepingPointer("), cm.indexOf("const TextWidget"));
        assertTrue(keep.contains("scroller.scrollTop += delta"), "换回原文以后没把那一行挪回点下去的高度");
    }

    @Test
    @DisplayName("编辑器一直开着以后，⌘W 在正文里也关标签（原来「在编辑就什么快捷键都不管」）；⌘[ ⌘] 光标在正文里时留给编辑器缩进")
    void 标签快捷键() throws Exception {
        String wiki = code("pages/knowledge-wiki.js");
        String keys = wiki.substring(wiki.indexOf("function wireWikiTabShortcuts()"), wiki.indexOf("function wikiExternalUrl("));
        assertFalse(keys.contains("if (doc && doc.dataset.editing === '1') return;"), "编辑器一直开着，这一句等于所有标签快捷键都不管用");
        assertTrue(keys.contains("var typing = doc && doc.contains(document.activeElement);")
                && keys.contains("if (e.key === '[' && !typing)") && keys.contains("else if (e.key === ']' && !typing)"), "⌘[ ⌘] 光标在正文里时要留给编辑器");
        assertTrue(keys.contains("else if (e.key === 'w' && state.wikiTabs.length)"), "⌘W 关标签不见了");
    }

    @Test
    @DisplayName("第八十四轮：页名在正文顶上 —— #zq-doc 每次整个换掉以后都要把页名放回去（漏一处，那种情况下页名就没了）；编辑器挂在 .zq-wiki-cm 上，不是 firstChild")
    void 页名跟着正文() throws Exception {
        String wiki = code("pages/knowledge-wiki.js");
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("doc\\.innerHTML = ").matcher(wiki);
        int writes = 0;
        while (m.find()) {
            writes++;
            int lineEnd = wiki.indexOf('\n', wiki.indexOf('\n', m.end()) + 1);   // 这一行和下一行
            String after = wiki.substring(m.end(), lineEnd < 0 ? wiki.length() : lineEnd);
            int stmt = wiki.indexOf("placeWikiTitle(doc)", m.end());
            boolean near = after.contains("placeWikiTitle(doc)")
                    || (stmt > 0 && !wiki.substring(m.end(), stmt).contains("doc.innerHTML = ") && wiki.substring(m.end(), stmt).split("\n").length <= 4);
            assertTrue(near, "这一处换掉了正文却没把页名放回去：" + wiki.substring(m.start(), Math.min(wiki.length(), m.start() + 120)));
        }
        assertTrue(writes >= 5, "只扫到 " + writes + " 处 doc.innerHTML —— 扫空了？");
        assertTrue(wiki.contains("wikiCmModule.mountWikiEditor(doc.querySelector('.zq-wiki-cm'),"), "编辑器又挂在 doc.firstChild 上（第一个是页名）");
        // review：页名节点第一次用到时才找；那时正文区要是已经被整个换掉了（页面里没有它），这一页从此没有页名 —— 找不到就自己建一个
        String find = wiki.substring(wiki.indexOf("function wikiTitleEl() {"), wiki.indexOf("function placeWikiTitle("));
        assertTrue(find.contains("wikiTitleNode = document.createElement('h1');") && find.contains("wikiTitleNode.className = 'zq-wiki-inline-title';"), "页名节点找不到时没有自己建一个");
    }
}
