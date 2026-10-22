package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 第八十一轮（docs/rounds/round-81.md）：看板和共用层的样子挪进样式表以后，按<b>状态</b>变的那几样靠类、{@code aria-*}、{@code hidden}，
 * 不再由 JS 一条一条写样子。内联样式还剩多少由 {@link InlineStyleRatchetTest} 按文件钉着；这里钉的是挪过去以后状态还画得对。
 */
class SharedLayerLookTest {

    private static final Path STATIC = Path.of("src/main/resources/static");

    private static String code(String file) throws Exception {
        return SourceText.stripComments(Files.readString(STATIC.resolve(file), StandardCharsets.UTF_8));
    }

    private static String css() throws Exception {
        return code("assets/zhiqu-ui.css");
    }

    /** 选择器正好是 selector 的那一条规则的声明（从行首或上一条的 } 开始）。 */
    private static String rule(String css, String selector) {
        Matcher m = Pattern.compile("(?:^|})\\s*" + Pattern.quote(selector) + "\\{([^}]*)\\}", Pattern.MULTILINE).matcher(css);
        assertTrue(m.find(), "样式表里找不到 " + selector);
        return m.group(1);
    }

    private static String between(String code, String from, String to) {
        int a = code.indexOf(from);
        assertTrue(a >= 0, "找不到 " + from);
        int b = code.indexOf(to, a + from.length());
        assertTrue(b > a, "找不到 " + to);
        return code.substring(a, b);
    }

    @Test
    @DisplayName("登录 / 注册：页签选中看 aria-selected、两张表用 hidden 切（原来 JS 改 fontWeight / color / borderBottomColor / display，选中时还写成 700）")
    void 登录页签() throws Exception {
        String api = code("assets/zhiqu-api.js");
        String form = between(api, "var AUTH_FORM_HTML =", "function switchAuthTab(");
        assertTrue(form.contains("class=\"zq-auth-tab\" role=\"tab\" aria-selected=\"true\" data-authtab=\"login\"")
                && form.contains("class=\"zq-auth-tab\" role=\"tab\" aria-selected=\"false\" data-authtab=\"register\""), "两个页签要带 aria-selected");
        assertTrue(form.contains("<form id=\"form-reg\" class=\"zq-auth-form\" hidden"), "注册那张表一开始藏着（hidden），不是内联 display:none");
        String sw = between(api, "function switchAuthTab(", "function wireAuthForms(");
        assertFalse(sw.contains(".style."), "切页签又在 JS 里改样子");
        assertTrue(sw.contains("fl.hidden = !lg") && sw.contains("fr.hidden = lg") && sw.contains("setAttribute('aria-selected'"), "切页签要改 hidden 和 aria-selected");
        String css = css();
        String on = rule(css, ".zq-auth-tab[aria-selected=\"true\"]");
        assertTrue(on.contains("font-weight:var(--zq-fw-medium)") && on.contains("border-bottom-color:var(--zq-primary)"), "选中的页签：500、主色下划线（不是 700）");
        assertTrue(rule(css, ".zq-auth-tab").contains("font-weight:var(--zq-fw-regular)"), "没选中的页签是 400");
    }

    @Test
    @DisplayName("右键菜单：样子和悬停在样式表（原来 cssText + onmouseenter / onmouseleave 写底色），位置是数据、JS 只写 left / top")
    void 右键菜单() throws Exception {
        String api = code("assets/zhiqu-api.js");
        String pop = between(api, "function popMenu(x, y, items) {", "\n  }\n");
        assertFalse(pop.contains("cssText") || pop.contains("onmouseenter") || pop.contains("style.background"), "右键菜单又在 JS 里画样子：\n" + pop);
        assertTrue(pop.contains("b.className = it.danger ? 'zq-popmenu-item is-danger' : 'zq-popmenu-item';"), "菜单项要挂 zq-popmenu-item（危险的那项 is-danger）");
        assertTrue(pop.contains("menu.style.left") && pop.contains("menu.style.top"), "位置还是 JS 按点的地方算");
        String css = css();
        assertTrue(rule(css, "#zq-popmenu").contains("position:fixed"), "菜单的样子不在样式表");
        assertTrue(rule(css, ".zq-popmenu-item:hover,.zq-popmenu-item:focus-visible").contains("background:var(--zq-tint)"), "悬停 / 键盘到上面时没有底色");
        assertTrue(rule(css, ".zq-popmenu-item.is-danger").contains("color:var(--zq-bad)"), "危险的那项不是红的");
    }

    @Test
    @DisplayName("持久通知关掉时真的淡出：入场动画停在最后一帧会压过 opacity（原来 JS 写 opacity:0 不起作用，220ms 后直接消失）—— 换一个淡出动画")
    void 通知淡出() throws Exception {
        String api = code("assets/zhiqu-api.js");
        String notice = between(api, "function notice(msg) {", "close: close");
        assertFalse(notice.contains(".style."), "通知又在 JS 里改样子");
        assertTrue(notice.contains("el.classList.add('is-closing'); setTimeout(function () { el.remove(); }, 220);"), "关的时候要挂 is-closing、等淡出播完再拿掉");
        String css = css();
        Matcher anim = Pattern.compile("animation:(\\w+) \\.(\\d+)s").matcher(rule(css, ".zq-notice.is-closing"));
        assertTrue(anim.find(), ".zq-notice.is-closing 不是一个动画（撤掉动画再改 opacity，浏览器不起过渡，当场就没了 —— 内置浏览器里量过）");
        assertTrue(Integer.parseInt(anim.group(2)) * 100 <= 220, "淡出比 JS 拿掉元素的 220ms 还长，播不完");
        assertTrue(css.contains("@keyframes " + anim.group(1) + "{from{opacity:1;}to{opacity:0;}}"), "淡出动画不是从 1 到 0");
    }

    @Test
    @DisplayName("标红的确认框用 .zq-btn-danger（原来是 .zq-btn 上内联一个红底：浅色下红底黑边、深色下红底深色字）")
    void 标红的确认() throws Exception {
        String api = code("assets/zhiqu-api.js");
        String confirm = between(api, "title: opts.title || '确认操作',", "onMount:");
        assertTrue(confirm.contains("(opts.danger ? 'zq-btn-danger' : 'zq-btn')"), "标红的确认按钮要换成 zq-btn-danger");
        assertFalse(confirm.contains("style="), "确认框里又写了内联样式");
        // 询问框的多行 / 单行输入框是同一个 id：最小高度只给多行的（挪的时候写成 #zq-ask-input，单行的也被撑到 100px —— 内置浏览器里量出来的）
        String css = css();
        assertTrue(rule(css, "textarea#zq-ask-input").contains("min-height:100px"), "多行的询问框没有最小高度");
        assertFalse(Pattern.compile("(?:^|})\\s*#zq-ask-input\\{", Pattern.MULTILINE).matcher(css).find(), "最小高度挂在 #zq-ask-input 上，单行的输入框也变成 100px 高");
    }

    @Test
    @DisplayName("看板：只有外层一个 <main>（原来里面又套了一个）；象限色的小圆点按 data-q 上色，四个象限 + 例行各一条")
    void 看板() throws Exception {
        String html = Files.readString(STATIC.resolve("dashboard.html"), StandardCharsets.UTF_8).replaceAll("(?s)<!--.*?-->", " ");
        assertEquals(1, html.split("<main", -1).length - 1, "看板里不止一个 <main>");
        assertTrue(html.contains("<div class=\"zq-dash-main\">"), "左栏应当是 .zq-dash-main 的 div");
        String dash = code("assets/pages/dashboard.js");
        assertTrue(dash.contains("<i class=\"zq-qdot\" data-q=\"' + dot + '\"></i>") && dash.contains("<i class=\"zq-qdot\" data-q=\"' + q + '\"></i>"),
                "「今天」和四象限的小圆点要挂 zq-qdot + data-q");
        String css = css();
        String[][] dots = {{"q1", "--zq-q1"}, {"q2", "--zq-q2"}, {"q3", "--zq-q3"}, {"q4", "--zq-q4"}, {"routine", "--zq-text3"}};
        for (String[] d : dots) {
            assertTrue(rule(css, ".zq-qdot[data-q=\"" + d[0] + "\"]").contains("background:var(" + d[1] + ")"), d[0] + " 的小圆点不是 " + d[1]);
        }
    }
}
