package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 第八十轮（docs/rounds/round-80.md）：用户把电脑操控打开之后，在重新打的桌面应用里用鼠标点出来的几处。
 * 编辑器本身的（链接单击打开、排版和阅读一致、重复页名藏起来、加载不上退回）在 wiki-cm-check.js 里跑真的实现；
 * 这里钉的是页面上的接线 —— 每一处都是「代码在、但用户在 WKWebView 里点不到 / 看错」那一类。
 */
class DesktopMouseFindingsTest {

    private static final Path ASSETS = Path.of("src/main/resources/static/assets");

    private static String code(String file) throws Exception {
        return SourceText.stripComments(Files.readString(ASSETS.resolve(file)));
    }

    private static String css() throws Exception {
        return SourceText.stripComments(Files.readString(ASSETS.resolve("zhiqu-ui.css")));
    }

    private static String rule(String css, String selector) {
        int at = css.indexOf(selector + "{");
        assertTrue(at >= 0, "样式表里找不到 " + selector);
        return css.substring(at, css.indexOf('}', at));
    }

    private static String function(String code, String head) {
        int at = code.indexOf(head);
        assertTrue(at >= 0, "找不到 " + head);
        int next = code.indexOf("\nfunction ", at + head.length());
        int nextAsync = code.indexOf("\nasync function ", at + head.length());
        int end = next < 0 ? code.length() : next;
        if (nextAsync >= 0 && nextAsync < end) end = nextAsync;
        return code.substring(at, end);
    }

    @Test
    @DisplayName("「页面检查」里没有编辑器的试用开关了（「试试新编辑器 / 换回现在的编辑器」），也不再读那个本机设置")
    void 试用开关去掉() throws Exception {
        String wiki = code("pages/knowledge-wiki.js");
        assertFalse(wiki.contains("zq-wiki-editor-switch"), "页面检查里还画着编辑器开关");
        assertFalse(css().contains("zq-wiki-editor-switch"), "样式表里还留着开关的样子");
        assertFalse(wiki.contains("zq.wikiEditor"), "还在读 / 写试用开关的本机设置");
        assertFalse(wiki.contains("试试新编辑器") || wiki.contains("换回现在的编辑器") || wiki.contains("验证版"), "界面上还有试用版的说法");
        assertTrue(wiki.contains("function wikiCmEnabled() { return !wikiCmFailed; }"), "新编辑器应当是默认的，只在加载不上时退回");
    }

    @Test
    @DisplayName("编辑器里单击渲染出来的链接就打开（原来只放光标 —— 正文点一下就进编辑，链接全都点不动）：按住的是左键、带着地址的那种")
    void 编辑器里单击链接打开() throws Exception {
        String cm = code("wiki-cm.js");
        int handlers = cm.indexOf("EditorView.domEventHandlers({");
        assertTrue(handlers >= 0, "找不到编辑器的鼠标处理");
        String mousedown = cm.substring(handlers, cm.indexOf("paste(event, view)", handlers));
        assertTrue(mousedown.contains("mousedown(event, view)"), "要接管按下鼠标");
        assertTrue(mousedown.contains("closest('.cm-zq-link[data-href]')"), "认的是渲染出来、带着地址的链接（光标在上面露出原文时不带地址，点了照旧放光标）");
        assertTrue(mousedown.contains("event.preventDefault();") && mousedown.contains("options.onOpenUrl(el.getAttribute('data-href'));"), "要打开，而不是放光标");
    }

    @Test
    @DisplayName("新建知识页：建完直接打开、进编辑；说明不再提已经不存在的「编辑」按钮")
    void 新建知识页打开() throws Exception {
        String create = function(code("pages/knowledge-wiki.js"), "function createWikiPage() {");
        int post = create.indexOf("await api.post('/knowledge/pages'");
        int open = create.indexOf("await paintWikiDoc(page, { newTab: true }); enterWikiEdit();");
        assertTrue(post >= 0 && open > post, "建完要打开新页并进编辑（原来只说「已创建」，正文还停在原来那一页）");
        assertFalse(create.contains("点击「编辑」"), "页面上早就没有「编辑」按钮了（点正文就编辑）");
    }

    @Test
    @DisplayName("桌面应用：页面认出外壳（zqNotify 那座桥）打上 zq-desktop，侧栏的内容从红黄绿按钮和 28px 的拖拽条下面开始")
    void 桌面应用侧栏让出标题栏() throws Exception {
        String ui = code("zhiqu-ui.js");
        assertTrue(Pattern.compile("messageHandlers\\.zqNotify\\)\\s*document\\.documentElement\\.classList\\.add\\('zq-desktop'\\)").matcher(ui).find(),
                "要按外壳注册的桥认出桌面应用");
        Matcher pad = Pattern.compile("padding-top:(\\d+)px").matcher(rule(css(), "html.zq-desktop .zq-side"));
        assertTrue(pad.find() && Integer.parseInt(pad.group(1)) > 28, "侧栏顶上要让过外壳 28px 高的拖拽条（ZhiquShell.swift 的 DragStrip）");
    }

    @Test
    @DisplayName("提示（toast）和持久通知不压每页标题行的按钮：原来贴在右上角 top:22px；挪到标题行下面也不行（窗口窄时按钮折成两排，Wiki 1024 宽时到 128px）—— 放到底部中间、不接鼠标，通知叠在提示上面")
    void 提示不挡按钮() throws Exception {
        String api = code("zhiqu-api.js");
        String toast = api.substring(api.indexOf("function toast(msg, kind, ms) {"), api.indexOf("function reportUnhandled("));
        assertFalse(toast.contains("cssText"), "提示的样子应当在样式表（.zq-toast）");
        assertTrue(toast.contains("'zq-toast"), "提示要用 .zq-toast");
        String css = css();
        int[] bottoms = new int[2];
        String[] selectors = {".zq-toast", ".zq-notice"};
        for (int i = 0; i < selectors.length; i++) {
            String r = rule(css, selectors[i]);
            assertTrue(r.contains("pointer-events:none"), selectors[i] + " 叠在什么上面都要让点击穿过去");
            assertFalse(Pattern.compile("(^|[;{])top:").matcher(r).find(), selectors[i] + " 不能按顶边放（标题行多高随窗口宽窄变）");
            assertTrue(r.contains("left:0;right:0;") && r.contains("margin:0 auto;") && r.contains("width:fit-content;"), selectors[i] + " 在底部居中（不用 transform：通知的入场动画会盖掉它）");
            Matcher bottom = Pattern.compile("bottom:(\\d+)px").matcher(r);
            assertTrue(bottom.find(), selectors[i] + " 要贴着底边放");
            bottoms[i] = Integer.parseInt(bottom.group(1));
        }
        assertTrue(bottoms[1] >= bottoms[0] + 44, "通知在提示上面，两个同时出现不互相盖");
    }

    @Test
    @DisplayName("第八十三轮：「保存 / 取消」那一条去掉了（自动保存）；保存的状态浮在正文卡片右下角、不占排版 —— 放在页名那一行的话，它一出一没，窄窗口里工具栏跟着换行、正文整块上下挪，点下去时字正好挪走")
    void 保存的状态不占排版() throws Exception {
        String css = css();
        String badge = rule(css, ".zq-wiki-save-state");
        assertTrue(badge.contains("position:absolute") && badge.contains("bottom:") && badge.contains("right:"), "保存的状态要浮在卡片角上，不在排版里占一块");
        assertTrue(rule(css, ".zq-wiki-doc").contains("position:relative"), "状态按正文卡片定位");
        assertTrue(rule(css, ".zq-wiki-save-state:empty").contains("display:none"), "没状态时不显示");
        assertFalse(css.contains(".zq-wiki-actionbar"), "原来底上的保存条还在样式表里");
        String html = Files.readString(Path.of("src/main/resources/static/knowledge-wiki.html"), java.nio.charset.StandardCharsets.UTF_8).replaceAll("(?s)<!--.*?-->", " ");
        int head = html.indexOf("<div class=\"zq-wiki-head\">"), doc = html.indexOf("<div id=\"zq-doc\""), state = html.indexOf("id=\"zq-wiki-save-state\"");
        assertTrue(head >= 0 && doc > head && state > doc, "保存的状态要放在正文后面（卡片里浮着），不能放进页名那一行");
        assertFalse(code("pages/knowledge-wiki.js").contains("zq-wiki-actions"), "页面还在建原来那条「保存 / 取消」");
        Matcher room = Pattern.compile("padding-bottom:(\\d+)px").matcher(rule(css, "#zq-doc[data-editing=\"1\"]"));
        assertTrue(room.find() && Integer.parseInt(room.group(1)) >= 40, "编辑时正文底下要留一段空：最后几行不贴着卡片底、也不被右下角的状态盖住");
    }

    @Test
    @DisplayName("进编辑、回阅读都对准同一个字：编辑器上面没画出来的行高度是估的（空行按整行估），按估的高度对位，长页中间点进编辑整页偏 32px —— 量一次挪一次直到对上；回阅读量的是那一段的第一个字，不是顶上那一行")
    void 进出编辑对准同一个字() throws Exception {
        String cm = code("wiki-cm.js");
        int at = cm.indexOf("const alignPos = (pos, clientTop, scroller, text, tries = 6) => view.requestMeasure({");
        assertTrue(at >= 0, "对位要在编辑器量过真实高度之后做（requestMeasure），不能按估的高度一次挪完");
        String align = cm.substring(at, cm.indexOf("});", at));
        assertTrue(align.contains("read: () => charTop(pos, text) - clientTop"), "量的是那个字现在的顶边");
        assertTrue(align.contains("scroller.scrollTop = before + delta;") && align.contains("if (scroller.scrollTop !== before) alignPos(pos, clientTop, scroller, text, tries - 1);"),
                "挪了外面那层滚动之后再量一次（上面的行画出来以后高度会变），挪不动就停");
        assertTrue(cm.contains("rect ? rect.top : view.documentTop + view.lineBlockAt(pos).top"), "那个字没画出来时先按估的行高挪过去，画出来再对准");
        assertTrue(cm.contains("const top = readingAnchorTop(el, { text, ordinal: 0 });"), "落在表格 / 公式预览里：在预览里找那段字量（量整块的顶差一个单元格的内边距）");
        int focus = cm.indexOf("focusPos(pos, clientTop, scroller) {");
        assertTrue(focus >= 0, "找不到 focusPos");
        String focusPos = cm.substring(focus, cm.indexOf("\n    },", focus));
        assertTrue(focusPos.contains("scrollIntoView: !align") && focusPos.contains("if (align) alignPos(pos, clientTop, scroller);"),
                "给了高度就走对位（不再按「点的高度减 14」让编辑器一次滚到位，那是按估的行高算的）");
        assertFalse(focusPos.contains("yMargin"), "不再用 scrollIntoView 的 yMargin 定位");
        assertTrue(cm.contains("const skip = (n) => n - 1 === layout.titleLine || (layout.lines[n - 1] && layout.lines[n - 1].blank);"),
                "顶上那一行是藏起来的页名（阅读时 display:none、量不出位置）或空行时往下找");
        String wiki = code("pages/knowledge-wiki.js");
        assertTrue(wiki.contains("enterWikiEdit({ focus: { x: e.clientX, y: e.clientY } });"), "点正文进编辑：把点的位置交给进编辑那一步，它在换掉阅读视图之前量那个字");
        String enter = function(wiki, "function enterWikiCmEdit(doc, p, markdown, opts) {");
        int clear = enter.indexOf("nativeSel.removeAllRanges()"), swap = enter.indexOf("doc.innerHTML = '<div class=\"zq-wiki-cm\"></div>';");
        assertTrue(clear >= 0 && swap > clear, "换掉阅读视图之前要清掉原生选区：WebKit 会把它挪到新内容里，编辑器读到它，光标从点的字跑到别的行（桌面应用里点正文第二行，光标落在上面的标题）");
        assertTrue(wiki.contains("wikiCm.handle.charTop(at, view.cmAnchor.text)") && wiki.contains("wikiCmModule.readingAnchorTop(md, view.cmAnchor)"),
                "保存 / 取消：编辑器里量那一段第一个字，阅读里也量那一段第一个字");
    }

    @Test
    @DisplayName("空的日期 / 时间框打上 data-zq-empty（输入、改值、脚本设值、新插进来的都算），样式表画成占位的灰色")
    void 空日期框是灰的() throws Exception {
        String ui = code("zhiqu-ui.js");
        assertTrue(ui.contains("el.setAttribute('data-zq-empty', '')") && ui.contains("el.removeAttribute('data-zq-empty')"), "要按有没有值打 / 去标记");
        assertTrue(ui.contains("Object.defineProperty(HTMLInputElement.prototype, 'value'"), "脚本设值（先开弹框、数据回来再填）也要跟着改标记，否则填了值的框是灰的");
        assertTrue(ui.contains("new MutationObserver("), "新插进来的框（弹框）要当场打标记");
        assertTrue(rule(css(), "input[data-zq-empty],input[data-zq-empty]::-webkit-datetime-edit").contains("color:var(--zq-text3)"),
                "WebKit 的日期框里的字在 ::-webkit-datetime-edit 上");
        assertTrue(rule(css(), "input[data-zq-empty]::-webkit-datetime-edit-text").contains("color:var(--zq-text3)"),
                "「/」「:」分隔符在单独的伪元素上（桌面应用里看到数字灰了、分隔符还是深色）");
    }
}
