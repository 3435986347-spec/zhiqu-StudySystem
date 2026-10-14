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

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 界面打磨第 7 步（第五十五轮，docs/ui-plan.md）：知识 Wiki 的正文和工具栏。
 *
 * <p>原来 Wiki 的正文和 AI 助手的聊天气泡一个样（13.5px、行距 1.75、段距 8px），没有行宽 —— 1440 宽的窗口里一行七十多个字；
 * 三级标题带下划线，比二级还显眼；样子写死在 renderMarkdown 的内联样式里，编辑器插进去的标题、勾选项和渲染出来的不一样。
 * 标题上面压着一行「文档视图」小字，工具栏是「B」「I」「U」「代码」「公式」「源码」一排字按钮；正文第一行往往又是一遍页名。
 *
 * <p>renderMarkdown 的标记在 markdown-check.js 里真跑；这里管样式表里那套读长文的排版、页面的头和工具栏、重复的页名。
 */
class WikiLookTest {

    private static final Path STATIC = Path.of("src/main/resources/static");

    private static String css() throws IOException {
        return Files.readString(STATIC.resolve("assets/zhiqu-ui.css"), StandardCharsets.UTF_8).replaceAll("(?s)/\\*.*?\\*/", "");
    }

    /** 选择器恰好是 selector 的那一条规则的声明（只认一条） */
    private static String rule(String css, String selector) {
        Matcher m = Pattern.compile("(?m)(?:^|})\\s*" + Pattern.quote(selector) + "\\{([^}]*)}").matcher(css);
        assertTrue(m.find(), "样式表里没有 " + selector + " 这一条");
        String decl = m.group(1);
        assertFalse(m.find(), selector + " 写了不止一条，判据不知道看哪条");
        return decl;
    }

    private static String prop(String decl, String name) {
        Matcher m = Pattern.compile("(?:^|;)\\s*" + Pattern.quote(name) + ":([^;]+)").matcher(decl);
        assertTrue(m.find(), "「" + decl + "」里没有 " + name);
        return m.group(1).trim();
    }

    /** 12px / 1.85 / var(--zq-fs-md)（到 :root 里找） → 数 */
    private static double px(String css, String value) {
        Matcher var = Pattern.compile("var\\((--[\\w-]+)\\)").matcher(value);
        if (var.matches()) {
            Matcher def = Pattern.compile(Pattern.quote(var.group(1)) + ":\\s*([\\d.]+)px").matcher(css);
            assertTrue(def.find(), ":root 里没有 " + var.group(1));
            return Double.parseDouble(def.group(1));
        }
        return Double.parseDouble(value.replaceAll("(px|em)$", ""));
    }

    @Test
    @DisplayName("Markdown 的标记（node 里真跑 renderMarkdown）：没有内联样式、每种块的样子、类和标签在样式表里有规则、别处不借用它的类")
    void 标记() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/markdown-check.js"), NodeRunner.API_JS), "markdown-check.js 没有全绿");
    }

    @Test
    @DisplayName("读长文的排版：行宽 34–46 个字、正文比聊天大、行距 ≥ 1.8；标题一级比一级小、最小的不小于正文、节前留白比节后多；三级标题不带下划线")
    void 排版() throws IOException {
        String css = css();
        String prose = rule(css, ".zq-prose .zq-md");
        String width = prop(prose, "max-width");
        assertTrue(width.endsWith("em"), "行宽要按字数（em）定，不按像素：" + width);
        double chars = px(css, width);
        assertTrue(chars >= 34 && chars <= 46, "一行 " + chars + " 个字 —— 中文长文一行 35–45 字读着最顺");
        double body = px(css, prop(prose, "font-size"));
        assertTrue(body > px(css, prop(rule(css, ".zq-md"), "font-size")), "Wiki 正文没有比聊天气泡里的字大");
        assertTrue(Double.parseDouble(prop(prose, "line-height")) >= 1.8, "行距太密");

        double above = Double.MAX_VALUE;
        for (int lvl = 1; lvl <= 4; lvl++) {
            String h = rule(css, ".zq-prose .zq-md h" + lvl);
            double size = px(css, prop(h, "font-size"));
            assertTrue(size < above, "h" + lvl + "（" + size + "px）不比上一级小");
            assertTrue(size >= body, "h" + lvl + "（" + size + "px）比正文（" + body + "px）还小");
            above = size;
            String[] margin = prop(h, "margin").split("\\s+");
            assertTrue(px(css, margin[0]) > px(css, margin[2]), "h" + lvl + " 节前的留白不比节后多 —— 标题会贴着上一节、离自己那节反而远");
        }
        assertEquals("none", prop(rule(css, ".zq-prose .zq-md h3"), "border-bottom"), "三级标题又带下划线了（比二级还显眼）");
    }

    @Test
    @DisplayName("页面：标题上面不压「文档视图」、没有「点击正文或标题即可编辑」；工具栏是一排图标按钮（各有 title 和 aria-label），「源码」按下时 aria-pressed；正文是 .zq-prose")
    void 页面() throws IOException {
        String html = Files.readString(STATIC.resolve("knowledge-wiki.html"), StandardCharsets.UTF_8).replaceAll("(?s)<!--.*?-->", "");
        assertFalse(html.contains("文档视图"), "标题上面又压着「文档视图」");
        assertFalse(html.contains("点击正文或标题即可编辑"), "又有「点击正文或标题即可编辑」那行提示");
        assertTrue(html.contains("<div id=\"zq-doc\" class=\"zq-prose\""), "正文容器没有 .zq-prose —— 读长文的那套排版不生效");
        assertTrue(html.contains("<h2 id=\"zq-doc-title\" class=\"zq-wiki-title\">"), "页名不是 .zq-wiki-title");

        Matcher b = Pattern.compile("<button([^>]*data-wiki-cmd=\"(\\w+)\"[^>]*)>(.*?)</button>").matcher(html);
        List<String> cmds = new ArrayList<>();
        while (b.find()) {
            cmds.add(b.group(2));
            assertTrue(b.group(1).contains(" title=\"") && b.group(1).contains(" aria-label=\""), b.group(2) + " 没有 title 或 aria-label（只有图标的按钮）");
            assertTrue(b.group(3).matches("<span data-zq-icon=\"[\\w-]+\"></span>"), b.group(2) + " 不是只有一个图标：" + b.group(3));
        }
        assertEquals(List.of("bold", "italic", "underline", "code", "link", "image", "math", "ref", "source"), cmds, "工具栏的按钮变了");
        assertTrue(html.contains("data-wiki-cmd=\"source\" class=\"zq-tbtn\" id=\"zq-wiki-source\""), "「源码」按钮没有 id —— setSourcePressed 找不到它");
        assertTrue(html.contains("aria-pressed=\"false\"><span data-zq-icon=\"file-code\">"), "「源码」按钮没有 aria-pressed（图标看不出现在是源码还是排版）");
    }

    @Test
    @DisplayName("和页名一样的一级标题：读的时候藏起来（只挂类，不删 —— 保存时原样写回去），编辑时露出来；每次把正文画成排版之后都要标")
    void 重复的页名() throws IOException {
        assertTrue(css().contains(".zq-prose:not([contenteditable=\"true\"]) .zq-dup-title{display:none;}"), "样式表里没有「不编辑时藏起重复的页名」");
        String js = SourceText.pageModule("knowledge-wiki.js");
        String mark = SourceText.functionBody(js, "function markDuplicateTitle(");
        assertTrue(mark.contains("classList.add('zq-dup-title')"), "markDuplicateTitle 没有挂类：\n" + mark);
        assertFalse(mark.contains("remove(") || mark.contains("removeChild") || mark.contains("innerHTML") || mark.contains("outerHTML"),
                "markDuplicateTitle 动了内容 —— 保存时页名那一行就没了：\n" + mark);
        // 把正文画成排版的每一处（打开一页、从源码回到排版）后面都紧跟着标一次
        Matcher paint = Pattern.compile("doc\\.innerHTML = renderMarkdown\\(").matcher(js);
        int n = 0;
        while (paint.find()) {
            n++;
            String after = js.substring(paint.end(), Math.min(js.length(), paint.end() + 160));
            assertTrue(after.contains("markDuplicateTitle(doc, "), "画完正文没有标重复的页名：\n" + after);
        }
        assertEquals(2, n, "把正文画成排版的地方应当是两处（打开一页、从源码回来）");
        // 第五十八轮 review：点正文进入编辑时这一行页名露出来，下面的字整体往下挪一截 —— 点哪一行，那一行就从手底下跳走（真浏览器量过：滚回去之后点的那一行纹丝不动）
        String click = SourceText.functionBody(js, "function wireWikiEditor(");
        int enter = click.indexOf("enterWikiEdit();");
        assertTrue(enter > 0 && click.indexOf("doc.scrollTop += dup.getBoundingClientRect().height", enter) > enter,
                "点正文进入编辑之后没有把露出来的页名那一截滚回去：\n" + click);
        assertTrue(click.indexOf("caretAt(e.clientX, e.clientY);", enter) > enter, "进入编辑之后光标没有放在点的地方");
    }
}
