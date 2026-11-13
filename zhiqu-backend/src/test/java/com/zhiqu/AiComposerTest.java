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
    @DisplayName("输入区是一个框：附件在上、输入框单独一行、工具一条在下（附件、档位、两个开关、模型、发送都在框里）；拖拽框不在框里")
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
        for (String id : List.of("zq-chat-upload", "zq-tier", "zq-web", "zq-effort", "zq-model", "zq-send")) {
            assertEquals(1, html.split("id=\"" + id + "\"", -1).length - 1, "#" + id + " 在页面上应该恰好一个");
            assertTrue(tools.contains("id=\"" + id + "\""), "#" + id + " 不在输入框底下那条工具里");
        }
        assertFalse(box.contains("id=\"zq-drop-zone\""), "拖拽框又进了输入框");
        for (String id : List.of("zq-web")) {
            Matcher b = Pattern.compile("<button id=\"" + id + "\"[^>]*>").matcher(tools);
            assertTrue(b.find() && b.group().contains("class=\"zq-chip\"") && b.group().contains("aria-pressed=\"false\"") && b.group().contains("aria-label=\""),
                    "#" + id + " 要是 .zq-chip、带 aria-pressed 和 aria-label（手机上只剩图标）");
        }
        Matcher send = Pattern.compile("<button id=\"zq-send\"[^>]*>(.*?)</button>").matcher(tools);
        assertTrue(send.find() && send.group().contains("class=\"zq-send\"") && send.group().contains("aria-label=\""), "发送键要是 .zq-send、有 aria-label");
        assertEquals("", send.group(1).replaceAll("<[^>]*>", "").trim(), "发送键只有一个箭头图标");
    }

    @Test
    @DisplayName("模型、思考档位、联网刷新后还在（用户：「每次刷新后…回到默认模型，深度思考等状态也没有保留」）；思考是五档、点开向上拉起（用户定的名字）：打开页面时读记下的，行为在 composer-prefs-check.js 里真跑")
    void 输入框下面的选择刷新后还在() throws Exception {
        String js = SourceText.stripComments(SourceText.pageModule("ai-assistant.js"));
        String boot = SourceText.functionBody(js, "async function bootAiAssistant()");
        assertTrue(boot.contains("restoreAiToggles();"), "打开页面时没有读记下的开关");
        assertFalse(boot.contains("setAiToggleState('web', false)"), "打开页面又把开关写死成关");
        assertTrue(boot.contains("effortBtn.onclick = toggleEffortMenu"), "思考档位的按钮没接上面板");
        assertFalse(js.contains("zq-think") || js.contains("'DEEP'"), "「深度思考」的开关还在");
        String html = html();
        assertFalse(html.contains("zq-think"), "「深度思考」的按钮还在");
        int composer = html.indexOf("<div id=\"zq-composer\" class=\"zq-composer\">");
        String box = PageHeadTest.elementAt(html, composer, "div");
        String tools = PageHeadTest.elementAt(box, box.indexOf("<div class=\"zq-composer-bar\">"), "div");
        assertTrue(tools.contains("<div id=\"zq-effort-pick\" class=\"zq-tier-pick\">"), "思考档位不在输入框下面那条工具里，或者被藏起来了（它不是只给管理员的）");
        assertTrue(tools.contains("id=\"zq-effort\" type=\"button\" class=\"zq-chip zq-tier\" aria-haspopup=\"menu\" aria-expanded=\"false\""), "思考档位不是一个会弹面板的按钮");
        assertTrue(tools.contains("id=\"zq-effort-menu\" class=\"zq-tier-menu\" role=\"menu\""), "没有思考档位的面板");
        assertTrue(rule(css(), ".zq-tier.is-on").contains("background:var(--zq-tint)"), "开着思考时按钮要看得出来（和联网按下一个样子）");
        assertTrue(boot.contains("loadAiModelSelect()"), "打开页面没有取模型列表");
        String send = SourceText.functionBody(js, "async function sendAiMessage(queuedText)");
        assertTrue(send.contains("var reasoningMode = reasoningModeForRequest();"), "发消息时没有用选的档位");
        assertEquals(2, send.split("reasoningMode: reasoningMode,", -1).length - 1, "乐观显示的消息和发给后端的请求都要带档位");
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/composer-prefs-check.js"), STATIC.resolve("assets/pages/ai-assistant.js")),
                "composer-prefs-check.js 没有全绿");
    }

    @Test
    @DisplayName("手机上（第一百零八轮，真浏览器 375 宽里看到的）：思考档位写着名字，一行放不下时模型和发送换到第二行，不把模型名挤没；面板向左展开，不出屏幕")
    void 手机上放得下() throws IOException {
        String css = css();
        String phone = css.substring(css.indexOf("@media (max-width: 760px){"));
        assertTrue(phone.contains(".zq-composer-bar{flex-wrap:wrap;}"), "手机上模型名被挤没了");
        assertTrue(phone.contains("#zq-effort-pick .zq-tier-menu{left:auto;right:0;}"), "手机上思考档位的面板会出屏幕");
    }

    @Test
    @DisplayName("点发送只发输入框里的字：按钮包一层，函数也只认字符串（线上出现过 [object PointerEvent]）")
    void 点发送不发事件() throws IOException {
        String js = SourceText.stripComments(SourceText.pageModule("ai-assistant.js"));
        String boot = SourceText.functionBody(js, "async function bootAiAssistant()");
        assertFalse(boot.contains("sendBtn.onclick = sendAiMessage"),
                "发送键直接绑了函数：点击事件会被当成要发的那句话，用户打的字被丢掉");
        assertTrue(boot.contains("sendBtn.onclick = function () { sendAiMessage(); }"),
                "发送键没有包一层，点一下发的不是输入框里的字");
        String send = SourceText.functionBody(js, "async function sendAiMessage(queuedText)");
        assertTrue(send.contains("typeof queuedText !== 'string'"),
                "sendAiMessage 不挡非字符串：DOM 事件传进来就成了 [object PointerEvent]");
    }

    @Test
    @DisplayName("联网按下的样子只在样式表里（按 aria-pressed）；JS 不再写内联样式、不写死字重")
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
        String send = SourceText.functionBody(js, "async function sendAiMessage(queuedText)");
        assertTrue(send.contains("sendButton.classList.add('is-busy'); sendButton.setAttribute('aria-label', '生成中（回车 = 排队）');"),
                "发送时没有换成「生成中」的样子");
        assertFalse(send.contains("sendButton.disabled = true"), "生成中把发送键禁掉了 —— 那样就没法排队发下一条");
        assertTrue(send.contains("endTurn(st)"), "收尾没有解除这一轮的生成状态");
        String sync = SourceText.functionBody(js, "function syncTurnUi()");
        assertTrue(sync.contains("button.classList.toggle('is-busy', !!st)") && sync.contains("生成中（回车 = 排队）")
                && sync.contains("发送（⌘/Ctrl + 回车）"), "发送键没有根据当前会话而不是后台旧会话同步状态");
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
    @DisplayName("第一百零五轮：项目在输入框上方，档位在输入框下面那条工具里（一个按钮，点开向上拉起面板，面板贴着输入框不出界）；左侧的工作区、齿轮、设置弹窗都没了；"
            + "聚焦时输入框里不再画一圈；选了马上变、只发一个请求、弹系统的选文件夹框这些行为在 ws-bar-check.js 里真跑")
    void 项目在上档位在下() throws Exception {
        String html = html();
        int wrap = html.indexOf("<div class=\"zq-composer-wrap\">");
        int at = html.indexOf("<div id=\"zq-ws-bar\" class=\"zq-ws-bar\" hidden>");
        int composer = html.indexOf("<div id=\"zq-composer\" class=\"zq-composer\">");
        assertTrue(wrap > 0 && at > wrap && composer > at, "项目那一条不在输入框正上方（要在 .zq-composer-wrap 里、#zq-composer 前面）");
        String bar = PageHeadTest.elementAt(html, at, "div");
        assertTrue(at + bar.length() <= composer, "那一条把输入框包进去了");
        assertTrue(bar.contains("id=\"zq-ws-project\" type=\"button\" class=\"zq-ws-project\" aria-haspopup=\"menu\" aria-expanded=\"false\""), "项目按钮不是一个会弹菜单的按钮");
        assertFalse(bar.contains("data-ws-mode"), "档位又回到输入框上方了");
        String box = PageHeadTest.elementAt(html, composer, "div");
        String tools = PageHeadTest.elementAt(box, box.indexOf("<div class=\"zq-composer-bar\">"), "div");
        assertTrue(tools.contains("<div id=\"zq-tier-pick\" class=\"zq-tier-pick\" hidden>"), "档位不在输入框下面那条工具里，或者默认没藏（不是管理员也看得见）");
        assertTrue(tools.contains("id=\"zq-tier\" type=\"button\" class=\"zq-chip zq-tier\" aria-haspopup=\"menu\" aria-expanded=\"false\""), "档位按钮不是一个会弹面板的按钮");
        assertTrue(tools.contains("id=\"zq-tier-menu\" class=\"zq-tier-menu\" role=\"menu\""), "没有档位面板");
        for (String gone : List.of("id=\"zq-ws\"", "zq-ws-tree", "zq-ws-settings", "zq-ai-ws")) {
            assertFalse(html.contains(gone), "左侧的工作区还在：" + gone);
        }
        String js = SourceText.stripComments(SourceText.pageModule("ai-assistant.js"));
        for (String gone : List.of("openWorkspaceSettings", "paintWorkspace(", "searchWorkspace", "'/workspace/files", "'/workspace/search")) {
            assertFalse(js.contains(gone), "左侧工作区的代码还在：" + gone);
        }
        String css = css();
        assertFalse(css.contains(".zq-ai-ws") || css.contains(".zq-ws-entry") || css.contains(".zq-ws-modes"), "左侧工作区 / 旧档位条的样式还在");
        // 第一百零八轮改了理由：有了两个档位按钮，面板都从输入框最左边弹出来就和按钮对不上；面板只写名字（150px），贴着按钮窄屏也不出界（真浏览器量过）
        assertTrue(rule(css, ".zq-tier-pick").contains("position:relative"), "面板要贴着自己的按钮，.zq-tier-pick 得是定位容器");
        String menu = rule(css, ".zq-tier-menu");
        assertTrue(menu.contains("position:absolute") && menu.contains("bottom:calc(100% + 6px)") && menu.contains("animation:zqPullUp"),
                "面板要向上拉起：" + menu);
        assertTrue(menu.contains("width:150px"), "面板只写名字，不该还是放说明时的宽度：" + menu);
        assertFalse(css.contains("zq-tier-item-desc") || css.contains("zq-tier-item-name") || js.contains("zq-tier-item-desc"), "档位下面的小字还在（用户：「去掉档位下面的小字」）");
        assertEquals("box-shadow:none;", rule(css, ".zq-composer textarea:focus"), "输入框聚焦时里面又画了一圈（全站的 textarea:focus 光圈，用户截图里的「矩形框」）");
        assertTrue(rule(css, ".zq-composer").contains("border:1px solid var(--zq-border)") && rule(css, ".zq-composer:focus-within").contains("border-color:"),
                "外框聚焦时不变色了 —— 去掉里面那一圈以后，聚焦就没有样子了");
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/ws-bar-check.js"), STATIC.resolve("assets/pages/ai-assistant.js")),
                "ws-bar-check.js 没有全绿");
    }

    @Test
    @DisplayName("第一百一十八轮：打 / 拉出命令面板、能当命令执行；命令那一段换颜色，靠后面垫一层排版完全相同的字")
    void 斜杠命令() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/slash-check.js"), STATIC.resolve("assets")), "slash-check.js 没有全绿");
        String html = html();
        int wrap = html.indexOf("<div class=\"zq-draft-wrap\">");
        int menu = html.indexOf("id=\"zq-slash-menu\"");
        int mirror = html.indexOf("id=\"zq-draft-mirror\"");
        int draft = html.indexOf("<textarea id=\"zq-draft\"");
        assertTrue(wrap > 0 && menu > wrap && mirror > menu && draft > mirror,
                "后面那层要排在输入框前面（输入框盖在上面才接得到打字和光标）");
        String css = Files.readString(STATIC.resolve("assets/zhiqu-ui.css"));
        String area = rule(css, ".zq-composer textarea"), back = rule(css, ".zq-draft-mirror");
        for (String prop : List.of("font", "padding")) {
            assertEquals(declared(area, prop), declared(back, prop), prop + " 和输入框不一样：字就对不上了，看到的和光标错开");
        }
        assertEquals("pre-wrap", declared(back, "white-space"), "换行要和输入框一样");
        assertEquals("break-word", declared(back, "overflow-wrap"), "长串折行要和输入框一样");
        assertEquals("none", declared(back, "display"), "平时不启用：输入框还是原来的样子");
        assertEquals("block", declared(rule(css, ".zq-composer.has-command .zq-draft-mirror"), "display"));
        String on = rule(css, ".zq-composer.has-command textarea");
        assertEquals("transparent", declared(on, "color"), "输入框的字不透明就把上了色的那层盖住了");
        assertEquals("var(--zq-text)", declared(on, "caret-color"), "字透明了光标也跟着没了");
        assertEquals("none", declared(on, "scrollbar-width"), "有滚动条的机器上折行宽度会和后面那层不一样");
        assertEquals("var(--zq-cmd)", declared(rule(css, ".zq-draft-cmd"), "color"));
    }

    private static String declared(String rule, String prop) {
        Matcher m = Pattern.compile("(?:^|;)" + Pattern.quote(prop) + ":([^;]+)").matcher(rule);
        assertTrue(m.find(), "找不到 " + prop + "：" + rule);
        return m.group(1).trim();
    }

    @Test
    @DisplayName("第一百一十六轮：生成的文件能预览、下载；别人写的文件名不能变成标签；HTML 关在没有同源权限的 iframe 里")
    void 生成的文件() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/generated-files-check.js"), STATIC.resolve("assets")),
                "generated-files-check.js 没有全绿");
    }

    @Test
    @DisplayName("产物卡片：代码草稿关掉确认框以后，卡片上还有「查看并确认」重新打开它（第九十二轮；在 node 里真跑）")
    void 代码草稿的卡片能再打开确认框() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/artifact-actions-check.js"), STATIC.resolve("assets/pages/ai-assistant.js")),
                "artifact-actions-check.js 没有全绿");
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
        // 第七十八轮起这一栏的样子在样式表的 .zq-ai-chat-col（原来是内联）
        assertTrue(column.substring(0, column.indexOf('>')).contains("class=\"zq-ai-chat-col\""), "对话这一栏不是 .zq-ai-chat-col 了");
        assertTrue(rule(css, ".zq-ai-chat-col").contains("position:relative"), "对话这一栏要是定位容器（那一层按它铺满）");
        assertTrue(column.contains("id=\"zq-drop-overlay\""), "那一层不在对话这一栏里");
    }

    @Test
    @DisplayName("两侧面板收起后：桌面上的竖条只有图标（名字不再竖排），手机上收起的面板是页签、名字照样露出来；Wiki 目录的页数挪到按钮提示里；展开时第一行给收起按钮让位")
    void 两侧面板的开关() throws IOException {
        String css = css();
        int phone = css.indexOf("@media (max-width: 760px){");
        assertTrue(phone > 0, "找不到手机那一段");
        assertTrue(rule(css.substring(0, phone), ".zq-rail .zq-rlabel").startsWith("display:none;"), "桌面上收起的竖条又竖排着面板的名字");
        assertFalse(css.contains("writing-mode:vertical"), "又有竖排的字");
        assertTrue(css.substring(phone).contains(".zq-panel-host>.zq-collapsed .zq-rlabel{display:block;"),
                "手机上收起的面板是正文上方的页签 —— 名字藏起来就只剩两个看不懂的图标");
        // 展开的面板第一行给右上角的收起按钮让位（第四十五轮：Wiki 目录的「4 页」叠在按钮底下，用户截图）—— 样式表一处，不再各页自己躲
        assertTrue(css.contains("[data-zq-collapse]>.zq-rail+*{padding-right:44px!important;}"), "面板第一行没给收起按钮让位");
        assertFalse(html().contains("margin-right:26px"), "又有按钮自己写 margin-right 躲收起按钮了");
        assertTrue(rule(css, ".zq-tip").contains("pointer-events:none"), "悬停提示要让鼠标穿过去（不然它一出来就挡住下面、触发移开）");
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
