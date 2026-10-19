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
 * 界面打磨第 9 步（一）（第七十八轮，docs/ui-plan.md）：AI 助手的样子从内联挪进样式表。
 *
 * <p>原来 {@code ai-assistant.html} 38 处、{@code pages/ai-assistant.js} 83 处内联样式；字号 10 / 10.5 / 11 / 11.5 / 12.5px 五种混着用；
 * 代码工作区设置里按下的档位靠 JS 改背景、文件夹选择器靠 {@code onmouseenter} 改底色（还是没有 href 的 {@code <a>}，Tab 不到），文件树拿 📁 📄 当图标。
 * 各个数由 {@link InlineStyleRatchetTest} 按文件钉着；这里管 AI 助手自己：剩下的内联只能是数据、字号都是令牌、按下 / 悬停在样式表里。
 */
class AiLookTest {

    private static final Path STATIC = Path.of("src/main/resources/static");

    private static String css() throws IOException {
        return SourceText.stripComments(Files.readString(STATIC.resolve("assets/zhiqu-ui.css"), StandardCharsets.UTF_8));
    }

    @Test
    @DisplayName("页面没有内联样式；模块里只剩资料卡片的类型色（--srcc）和输入框按内容长高（style.height）")
    void 只剩数据() throws IOException {
        String html = Files.readString(STATIC.resolve("ai-assistant.html"), StandardCharsets.UTF_8).replaceAll("(?s)<!--.*?-->", "");
        assertFalse(html.contains("style="), "ai-assistant.html 又写了内联样式");
        String js = SourceText.pageModule("ai-assistant.js");
        assertTrue(js.length() > 50000, "ai-assistant.js 只读到 " + js.length() + " 字 —— 读错文件了？");
        Matcher inline = Pattern.compile("style=\\\\?\"([^\"]{0,40})").matcher(js);
        List<String> found = new ArrayList<>();
        while (inline.find()) found.add(inline.group(1));
        assertEquals(1, found.size(), "ai-assistant.js 的内联样式：" + found);
        assertTrue(found.get(0).startsWith("--srcc:"), "唯一的内联不是资料卡片的类型色：" + found);
        Matcher write = Pattern.compile("\\.style\\.(\\w+)|cssText").matcher(js);
        List<String> writes = new ArrayList<>();
        while (write.find()) writes.add(write.group());
        assertEquals(List.of(".style.height", ".style.height", ".style.height"), writes, "AI 助手又在 JS 里改样子了（只许输入框按内容长高）");
    }

    @Test
    @DisplayName("AI 助手的规则里字号都是令牌（--zq-fs-2xs 是这一轮加的 11px：两侧面板的元信息、差异行）")
    void 字号都是令牌() throws IOException {
        String css = css();
        assertTrue(css.contains("--zq-fs-2xs: 11px;"), "没有 --zq-fs-2xs 这个令牌");
        Matcher rule = Pattern.compile("([^{}]*)\\{([^{}]*)\\}").matcher(css);
        Pattern ai = Pattern.compile("\\.zq-(?:ai-|src-|step|diff|ws-|wss-|fp-|nb|artifact|plan-|msg|chat-more|fill-page|composer|chip|send)|#zq-(?:chat|ws-|wss-|fp-|new-notebook|nb-desc)");
        int rules = 0;
        List<String> literal = new ArrayList<>();
        while (rule.find()) {
            String selector = rule.group(1).trim();
            if (!ai.matcher(selector).find()) continue;
            rules++;
            Matcher fs = Pattern.compile("font-size:\\s*[0-9.]+px").matcher(rule.group(2));
            if (fs.find()) literal.add(selector + " → " + fs.group());
        }
        assertTrue(rules >= 120, "只扫到 " + rules + " 条 AI 助手的规则 —— 扫空了？");
        assertEquals(List.of(), literal, "AI 助手的规则里又写死了字号");
    }

    @Test
    @DisplayName("工作区设置：按下的档位是 aria-pressed、样子在样式表；选文件夹的每一项是按钮、悬停的底色在样式表；文件树用 ICONS 的 folder / file")
    void 工作区的按下和悬停() throws IOException {
        String js = SourceText.pageModule("ai-assistant.js");
        String paint = js.substring(js.indexOf("function paintModes()"), js.indexOf("descEl.textContent", js.indexOf("function paintModes()")));
        assertTrue(paint.contains("setAttribute('aria-pressed'"), "档位按下的样子又不是 aria-pressed：" + paint);
        assertTrue(js.contains("role=\"group\" aria-labelledby=\"zq-wss-modes-label\""), "四个档位没有成组、没有名字");
        assertFalse(js.contains("onmouseenter") || js.contains("onmouseleave"), "又在 JS 里画悬停");
        assertTrue(js.contains("document.createElement('button');\n          a.type = 'button';\n          a.className = 'zq-fp-item';"),
                "选文件夹的一项不是按钮了（原来是没有 href 的 <a>，键盘 Tab 不到）");
        assertTrue(js.contains("icon(e.directory ? 'folder' : 'file')") && js.contains("icon('folder') + '<span class=\"zq-fp-name\">'"), "文件树 / 选文件夹没用 ICONS 的 folder / file");
        String css = css();
        assertTrue(css.contains(".zq-wss-modes .zq-btn-ghost[aria-pressed=\"true\"]{border-color:var(--zq-primary);background:var(--zq-primary);color:var(--zq-on-primary);}"),
                "按下的档位在样式表里没有样子");
        assertTrue(css.contains(".zq-fp-item:hover{background:var(--zq-card-soft);}") && css.contains(".zq-ws-entry:hover,.zq-ws-hit:hover{background:var(--zq-card-soft);}"),
                "选文件夹 / 文件树的悬停没有样子");
        assertTrue(css.contains(".zq-fp-bar .zq-btn-ghost:disabled{opacity:.4;"), "「上一层」到顶了不灰（原来靠 JS 改 opacity）");
        String ui = Files.readString(STATIC.resolve("assets/zhiqu-ui.js"), StandardCharsets.UTF_8);
        assertTrue(ui.contains("    'folder': '<path") && ui.contains("    'file': '<path"), "ICONS 里没有 folder / file");
    }

    @Test
    @DisplayName("资料卡片：类型和信息栏都在文档流里，卡片不钉死成正方形（原来 93px 的格子里信息栏把类型整个盖住）")
    void 资料卡片的类型不被盖住() throws IOException {
        String css = css();
        Matcher tile = Pattern.compile("\\n\\.zq-src-tile\\{([^}]*)\\}").matcher(css);
        assertTrue(tile.find(), "样式表里没有 .zq-src-tile");
        assertTrue(tile.group(1).contains("display:flex;flex-direction:column;aspect-ratio:1/1;"), "卡片不是一列排的了：" + tile.group(1));
        assertFalse(tile.group(1).contains("overflow:hidden"), "卡片又 overflow:hidden 了 —— aspect-ratio 就成了定高，放不下的被裁掉、被盖住");
        assertFalse(tile.group(1).contains("min-height:"), "卡片又写了定值的 min-height —— aspect-ratio 按内容撑高的那一条就不算了");
        for (String part : List.of(".zq-src-type", ".zq-src-glass")) {
            Matcher m = Pattern.compile("\\n" + Pattern.quote(part) + "\\{([^}]*)\\}").matcher(css);
            assertTrue(m.find(), "样式表里没有 " + part);
            assertTrue(m.group(1).startsWith("flex:none;") && !m.group(1).contains("position:absolute"), part + " 又是绝对定位、或者会被压扁：" + m.group(1));
        }
    }

    @Test
    @DisplayName("执行轨迹、消息的提示、资料的状态点：颜色看 data-state，在样式表里")
    void 颜色看数据() throws IOException {
        String js = SourceText.pageModule("ai-assistant.js");
        String steps = SourceText.functionBody(js, "function renderSteps(");
        assertTrue(steps.contains("'<div class=\"zq-step\" data-state=\"' + tone + '\">"), "执行轨迹的一步不是按 data-state 上色");
        assertFalse(steps.contains("var(--zq-"), "执行轨迹又在 JS 里拼颜色");
        String css = css();
        for (String r : List.of(
                ".zq-step[data-state=\"ok\"] .zq-step-dot{background:var(--zq-ok);}",
                ".zq-step[data-state=\"bad\"] .zq-step-dot{background:var(--zq-bad);}",
                ".zq-msg-note[data-state=\"bad\"]{color:var(--zq-bad);}",
                ".zq-msg-note[data-state=\"warn\"]{color:var(--zq-warn);}",
                ".zq-src-dot[data-state=\"ok\"]{background:var(--zq-ok);}",
                ".zq-src-dot[data-state=\"bad\"]{background:var(--zq-bad);}",
                ".zq-nb[aria-current=\"true\"]{border-color:var(--zq-tint-strong);background:var(--zq-tint);}")) {
            assertTrue(css.contains(r), "样式表里没有 " + r);
        }
        assertTrue(js.contains("<div data-msg-error class=\"zq-msg-note\" data-state=\"bad\">") && js.contains("<div data-msg-notice class=\"zq-msg-note\" data-state=\"warn\">"),
                "消息的出错 / 不完整提示没有按 data-state 上色");
    }
}
