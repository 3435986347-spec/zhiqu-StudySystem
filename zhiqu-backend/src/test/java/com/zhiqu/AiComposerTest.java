package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
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
 * 界面打磨第 4 步（第四十四轮，docs/ui-plan.md）：AI 助手的输入区、拖文件、消息排版。
 * 原来输入区是一条常驻的虚线拖拽框 + 一排六个小按钮（上传 / 输入框 / 联网 / 深度思考 / 模型 / 发送），像表单；
 * 开关按下的样子在 JS 里一项一项写内联样式；页面右上角摆着「已同步 50 条历史消息」；每条消息左右各一个头像、都套着气泡。
 * 两侧面板的开关在 ui-shell-check.js 里（真跑 zhiqu-ui.js），拖文件的行为在 ai-drop-check.js 里（真跑抠出来的 bindAiDropZone）。
 */
class AiComposerTest {

    private static final Path STATIC = Path.of("src/main/resources/static");

    private static String html() throws IOException {
        return Files.readString(STATIC.resolve("ai-assistant.html"), StandardCharsets.UTF_8);
    }

    private static String css() throws IOException {
        return SourceText.stripComments(Files.readString(STATIC.resolve("assets/zhiqu-ui.css"), StandardCharsets.UTF_8));
    }

    private static String rule(String css, String selector) {
        // 规则要从上一条的「}」之后开始：不然找 .zq-msg-body 会先撞上「.zq-msg.is-me .zq-msg-body{」
        Matcher m = Pattern.compile("(?:^|\\})\\s*" + Pattern.quote(selector) + "\\{([^}]*)\\}").matcher(css);
        assertTrue(m.find(), "样式表里找不到 " + selector);
        return m.group(1);
    }

    @Test
    @DisplayName("输入区是一个框：附件在上、输入框单独一行、工具一条在下（附件、三个开关、模型、发送都在框里）；拖拽框不在框里")
    void 输入区的结构() throws IOException {
        String html = html();
        int at = html.indexOf("<div id=\"zq-composer\" class=\"zq-composer\">");
        assertTrue(at > 0, "找不到输入区 #zq-composer");
        String box = PageHeadTest.elementAt(html, at, "div");
        int attach = box.indexOf("id=\"zq-attachments\"");
        int draft = box.indexOf("<textarea id=\"zq-draft\"");
        int bar = box.indexOf("<div class=\"zq-composer-bar\">");
        assertTrue(attach > 0 && draft > attach && bar > draft, "输入区里的顺序应该是 附件 → 输入框 → 工具条");
        String textarea = box.substring(draft, box.indexOf('>', draft));
        assertFalse(textarea.contains("style="), "输入框又写了内联样式（原来 min-width:200px，和按钮挤在一排）：" + textarea);
        String tools = PageHeadTest.elementAt(box, bar, "div");
        for (String id : List.of("zq-chat-upload", "zq-code", "zq-web", "zq-think", "zq-model", "zq-send")) {
            assertEquals(1, html.split("id=\"" + id + "\"", -1).length - 1, "#" + id + " 在页面上应该恰好一个");
            assertTrue(tools.contains("id=\"" + id + "\""), "#" + id + " 不在输入框底下那条工具里");
        }
        assertFalse(box.contains("id=\"zq-drop-zone\""), "拖拽框又进了输入框");
        for (String id : List.of("zq-web", "zq-think", "zq-code")) {
            Matcher b = Pattern.compile("<button id=\"" + id + "\"[^>]*>").matcher(tools);
            assertTrue(b.find() && b.group().contains("class=\"zq-chip\"") && b.group().contains("aria-pressed=\"false\"") && b.group().contains("aria-label=\""),
                    "#" + id + " 要是 .zq-chip、带 aria-pressed 和 aria-label（手机上只剩图标）");
        }
        Matcher send = Pattern.compile("<button id=\"zq-send\"[^>]*>(.*?)</button>").matcher(tools);
        assertTrue(send.find() && send.group().contains("class=\"zq-send\"") && send.group().contains("aria-label=\""), "发送键要是 .zq-send、有 aria-label");
        assertEquals("", send.group(1).replaceAll("<[^>]*>", "").trim(), "发送键只有一个箭头图标");
    }

    @Test
    @DisplayName("联网 / 深度思考 / 代码按下的样子只在样式表里（按 aria-pressed）；JS 不再写内联样式、不写死字重")
    void 开关的样子在样式表里() throws IOException {
        String js = SourceText.stripComments(SourceText.pageModule("ai-assistant.js"));
        String toggle = SourceText.functionBody(js, "function setAiToggleState(kind, on)");
        assertTrue(toggle.contains("button.setAttribute('aria-pressed', on ? 'true' : 'false');"), "开关没写 aria-pressed");
        assertFalse(toggle.contains(".style."), "开关又在 JS 里写内联样式了：\n" + toggle);
        assertFalse(js.contains("fontWeight"), "AI 助手的脚本里又写死了字重");
        String pressed = rule(css(), ".zq-chip[aria-pressed=\"true\"]");
        assertTrue(pressed.contains("background:var(--zq-tint)") && pressed.contains("color:var(--zq-primary)"), "按下的开关没有自己的样子：" + pressed);
    }

    @Test
    @DisplayName("发送中：箭头换成转圈（样式表画）、读屏念「生成中」，回来换回；输入框的起始 / 最高高度和样式表一致")
    void 发送中() throws IOException {
        String js = SourceText.stripComments(SourceText.pageModule("ai-assistant.js"));
        String send = SourceText.functionBody(js, "async function sendAiMessage()");
        assertTrue(send.contains("sendButton.disabled = true; sendButton.classList.add('is-busy'); sendButton.setAttribute('aria-label', '生成中');"),
                "发送时没有换成「生成中」的样子");
        assertTrue(send.contains("sendButton.disabled = false; sendButton.classList.remove('is-busy');"), "回来之后没有换回发送键");
        assertFalse(send.contains("sendButton.textContent"), "又往发送键里写字了 —— 会把箭头图标冲掉");
        String css = css();
        assertEquals("display:none;", rule(css, ".zq-send.is-busy .zq-icon"), "发送中箭头没有藏起来");
        assertTrue(rule(css, ".zq-send.is-busy::after").contains("animation:zqSpin"), "发送中没有转圈");
        assertTrue(css.contains("@keyframes zqSpin{"), "转圈的动画没定义");
        // 输入框的高度由 growDraft 写在内联样式里：起始高度和样式表不一致，打第一个字时输入框就跳一下
        Matcher base = Pattern.compile("var DRAFT_BASE_HEIGHT = (\\d+);").matcher(js);
        Matcher max = Pattern.compile("var DRAFT_MAX_HEIGHT = (\\d+);").matcher(js);
        assertTrue(base.find() && max.find(), "找不到输入框的起始 / 最高高度");
        String area = rule(css, ".zq-composer textarea");
        assertTrue(area.contains(";height:" + base.group(1) + "px;") && area.contains("max-height:" + max.group(1) + "px;"),
                "输入框的高度：脚本里是 " + base.group(1) + " / " + max.group(1) + "，样式表是 " + area);
        assertTrue(SourceText.functionBody(js, "function growDraft()").contains("Math.min(el.scrollHeight, DRAFT_MAX_HEIGHT)"), "自适应高度没用 DRAFT_MAX_HEIGHT");
    }

    @Test
    @DisplayName("拖文件：拖拽框平时不出现（桌面也是），拖到对话这一栏上方时整栏盖一层；进出子元素不闪、拖的不是文件不管（在 node 里真跑）")
    void 拖文件() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/ai-drop-check.js"), STATIC.resolve("assets/pages/ai-assistant.js")),
                "ai-drop-check.js 没有全绿");
        String css = css();
        int phone = css.indexOf("@media (max-width: 760px){");
        int hide = css.indexOf(".zq-ai-drop-zone:not(.is-uploading):not(.is-error){display:none;}");
        assertTrue(phone > 0 && hide > 0 && hide < phone, "拖拽框「平时不出现」只在手机上生效（要在 @media 外面，桌面也一样）");
        assertTrue(css.contains("#zq-chat-col.is-dragging .zq-drop-overlay{display:flex;}"), "拖着文件时那一层没有露出来的规则");
        assertTrue(rule(css, ".zq-drop-overlay").contains("pointer-events:none"), "那一层要让拖拽事件穿过去（不然它一盖上，下面的栏就收到 dragleave）");
        String html = html();
        int col = html.indexOf("<div id=\"zq-chat-col\"");
        assertTrue(col > 0, "找不到对话这一栏 #zq-chat-col");
        String column = PageHeadTest.elementAt(html, col, "div");
        assertTrue(column.substring(0, column.indexOf('>')).contains("position:relative"), "对话这一栏要是定位容器（那一层按它铺满）");
        assertTrue(column.contains("id=\"zq-drop-overlay\""), "那一层不在对话这一栏里");
    }

    @Test
    @DisplayName("两侧面板收起后：桌面上的竖条只有图标（名字不再竖排），手机上收起的面板是页签、名字照样露出来；Wiki 目录的页数挪到按钮提示里")
    void 两侧面板的开关() throws IOException {
        String css = css();
        int phone = css.indexOf("@media (max-width: 760px){");
        assertTrue(phone > 0, "找不到手机那一段");
        assertTrue(rule(css.substring(0, phone), ".zq-rail .zq-rlabel").startsWith("display:none;"), "桌面上收起的竖条又竖排着面板的名字");
        assertFalse(css.contains("writing-mode:vertical"), "又有竖排的字");
        assertTrue(css.substring(phone).contains(".zq-panel-host>.zq-collapsed .zq-rlabel{display:block;"),
                "手机上收起的面板是正文上方的页签 —— 名字藏起来就只剩两个看不懂的图标");
        String wiki = SourceText.stripComments(SourceText.pageModule("knowledge-wiki.js"));
        assertTrue(wiki.contains("xb.title = '展开「' + lbl + '」'; xb.setAttribute('aria-label', xb.title);"),
                "Wiki 目录的页数（原来写在竖条上）没有挪进展开按钮的提示");
    }

    @Test
    @DisplayName("页面上不摆调试信息：「已同步 N 条历史消息」和跳动的绿点去掉了")
    void 没有调试信息() throws IOException {
        String html = html();
        String js = SourceText.pageModule("ai-assistant.js");
        assertTrue(html.contains("<h1 class=\"zq-h1\">AI 助手</h1>") && js.contains("function renderAiMessages(opts)"), "扫错了文件");
        assertFalse(html.contains("zq-sync-count") || js.contains("zq-sync-count"), "同步计数又回来了");
        assertFalse(html.contains("已同步") || js.contains("已同步"), "「已同步」又回来了");
        assertFalse(html.contains("zqPulse"), "AI 助手页上又有跳动的点");
    }

    @Test
    @DisplayName("消息：用户的话是右边一个气泡，AI 的回答不套气泡、没有头像；一栏和输入框同宽（最宽 760px）、居中；样子都在样式表里")
    void 消息排版() throws IOException {
        String render = SourceText.functionBody(SourceText.pageModule("ai-assistant.js"), "function renderAiMessages(opts)");
        int a = render.indexOf("state.messages.map(function (m, i) {");
        int b = render.indexOf("}).join('');", a);
        assertTrue(a > 0 && b > a, "找不到画消息的那一段");
        String row = render.substring(a, b);
        assertTrue(row.contains("class=\"zq-msg ' + (me ? 'is-me' : 'is-ai') + '\""), "消息行没有分「我 / AI」的类");
        assertFalse(row.contains("style="), "消息行又写回内联样式了：\n" + row);
        assertFalse(row.contains("'我'") || row.contains("'AI'"), "消息又带上了头像");
        String css = css();
        assertTrue(css.contains(".zq-composer-wrap>*,.zq-msg{width:100%;max-width:760px;margin-left:auto;margin-right:auto;}"),
                "消息一栏和输入框不再同宽、居中");
        assertTrue(rule(css, ".zq-msg.is-me .zq-msg-body").contains("background:"), "用户的话没有气泡");
        String ai = rule(css, ".zq-msg.is-ai .zq-msg-body");
        assertFalse(ai.contains("background") || ai.contains("border") || ai.contains("padding"), "AI 的回答又套上气泡了：" + ai);
        assertTrue(rule(css, ".zq-msg-body").contains("font-size:var(--zq-fs-base)"), "消息正文的字号不是令牌里的正文字号");
    }
}
