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
 * 界面打磨第 8 步（四）（第七十七轮，docs/ui-plan.md）：后台四页和落地页。
 *
 * <p>原来监管后台六个数里三个读接口从来没有的字段（永远是 0）；账号管理的操作按钮往左溢出盖住日期、表下的说明被个数盖掉、手机上整张表横着滚；
 * 反馈「关闭」没走 safe、关完回到「全部」；共享计划同一行的卡片被拉成一样高、分类写代码「OTHER」；落地页标题断成「可控」一个人一行。
 * 画法和行为在 admin-check.js 里真跑（替身照接口真实的回包写）；这里管页面、样式表的静态那一半。
 */
class AdminLookTest {

    private static final Path STATIC = Path.of("src/main/resources/static");
    private static final List<String> PAGES = List.of("admin.html", "account-admin.html", "feedback-admin.html", "shared-plan-admin.html");

    private static String read(String name) throws IOException {
        return Files.readString(STATIC.resolve(name), StandardCharsets.UTF_8);
    }

    private static String css() throws IOException {
        return read("assets/zhiqu-ui.css");
    }

    @Test
    @DisplayName("行为（node 里真跑 pages/admin.js）：六个数只用接口真有的字段、柱子、反馈的筛选和关闭、账号的行和连查、共享计划的分类和状态")
    void 行为() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/admin-check.js"), STATIC.resolve("assets/pages/admin.js")), "admin-check.js 没有全绿");
    }

    @Test
    @DisplayName("四页和落地页没有内联样式；模块只有柱子的 --v（数据），不在 JS 里改样子")
    void 没有内联样式() throws IOException {
        for (String page : PAGES) {
            String html = read(page).replaceAll("(?s)<!--.*?-->", "");
            String main = html.substring(html.indexOf("<main class=\"zq-main\""), html.indexOf("</main>"));
            assertFalse(main.contains("style="), page + " 又写了内联样式");
        }
        String home = read("index.html").replaceAll("(?s)<!--.*?-->", "");
        assertFalse(home.substring(home.indexOf("<body")).contains("style="), "落地页又写了内联样式");
        String js = SourceText.pageModule("admin.js");
        assertTrue(js.length() > 10000, "admin.js 只读到 " + js.length() + " 字 —— 读错文件了？");
        Matcher inline = Pattern.compile("style=\\\\?\"(?!--v:)").matcher(js);
        assertFalse(inline.find(), "admin.js 又在拼内联样式（只许柱子的 --v）：" + (inline.find(0) ? js.substring(inline.start(), Math.min(js.length(), inline.start() + 60)) : ""));
        assertFalse(js.contains(".style."), "admin.js 又在 JS 里改样子（按下的样子靠 aria-pressed，颜色靠 data-state）");
    }

    @Test
    @DisplayName("监管后台不读接口没有的字段（todayRequests / aiRequests / rateLimited —— 原来这三个数永远是 0）")
    void 不读没有的字段() throws IOException {
        String js = SourceText.pageModule("admin.js");
        for (String field : List.of("todayRequests", "aiRequests", "rateLimited", "requestCount")) {
            assertFalse(js.contains(field), "admin.js 又读了接口没有的字段 " + field);
        }
        for (String field : List.of("t.last15Minutes", "t.lastMinute", "t.errorCount", "t.averageLatencyMs", "t.totalRecorded")) {
            assertTrue(js.contains(field), "监管后台没读 traffic 里的 " + field);
        }
    }

    @Test
    @DisplayName("账号管理：列宽只在样式表的 .zq-acct-row 一处（表头和行同一个类），都是定宽（表头对得上列）、操作列放得下三个按钮；说明和个数各一处；搜索框、角色下拉有标签")
    void 账号管理() throws IOException {
        String html = read("account-admin.html");
        assertTrue(html.contains("<div class=\"zq-thead zq-acct-row\">"), "表头不是 .zq-acct-row");
        assertTrue(html.contains("<span id=\"zq-acct-count\"></span><span>禁用后该账号无法登录，数据保留</span>"), "个数和说明不是各一处（原来个数把说明盖掉了）");
        assertTrue(html.contains("aria-label=\"搜索用户名或邮箱\"") && html.contains("<select id=\"zq-acct-role\" class=\"zq-select\" aria-label=\"角色\"><option value=\"\">"), "搜索框 / 角色下拉没有标签或值");
        assertFalse(html.contains("grid-template-columns"), "表头又自己写了列宽");
        String css = css();
        Matcher row = Pattern.compile("\\n\\.zq-acct-row\\{([^}]*)\\}").matcher(css);
        assertTrue(row.find(), "样式表里没有 .zq-acct-row");
        Matcher cols = Pattern.compile("grid-template-columns:([^;]*);").matcher(row.group(1));
        assertTrue(cols.find(), ".zq-acct-row 没有列宽");
        assertFalse(cols.group(1).matches(".*\\b(max-content|min-content|fit-content|auto)\\b.*"),
                "列宽里有按内容定的轨道：表头和每一行是各自的网格，按内容宽就各算各的，表头对不上列（第七十七轮先写成 max-content，「操作」那一格只有 24px 宽，前面几列整体右移）");
        Matcher last = Pattern.compile("(\\d+)px$").matcher(cols.group(1).trim());
        assertTrue(last.find() && Integer.parseInt(last.group(1)) >= 168, "操作那一列放不下三个按钮（「重置密码」「禁用」「删除」要 168px；原来 128px，往左溢出盖住了日期）：" + cols.group(1));
        assertFalse(row.find(), ".zq-acct-row 的列宽写了不止一处");
        assertTrue(css.contains("\n#zq-acct-search{width:200px;}"), "搜索框的宽度压不过全局那条 input{width:100%}（权重 0,2,1）：桌面上它占满一行，角色和「查询」掉到第二行");
        String phone = css.substring(css.lastIndexOf("@media (max-width: 760px)"));
        assertTrue(phone.contains(".zq-acct .zq-thead{display:none;}") && phone.contains(".zq-acct-row:not(.zq-thead){display:flex;flex-wrap:wrap;"),
                "手机上账号的一行没有叠起来（原来整张表横着滚，角色、状态、操作都在屏幕外）");
        assertTrue(phone.contains(".zq-acct-joined::before{content:\"注册于 \";}"), "手机上表头藏起来了，日期前面没写「注册于」，光一个日期看不出是什么");
        assertTrue(phone.contains(".zq-admin-metrics{grid-template-columns:repeat(2,minmax(0,1fr));}") && phone.contains(".zq-admin-cols,.zq-reviews{grid-template-columns:minmax(0,1fr);}"),
                "手机上监管后台的六个数没有两个一排、两栏 / 共享计划没有变一栏（原来是内联的网格，由 MobileLayoutTest 按 style 认；挪进类之后在这里认）");
    }

    @Test
    @DisplayName("反馈的筛选写在页面里（.zq-seg + aria-pressed + 个数），共享计划的卡片按自己的高度、长标题能换行")
    void 反馈和共享计划() throws IOException {
        String html = read("feedback-admin.html");
        assertTrue(html.contains("<div class=\"zq-seg\" id=\"zq-filters\" role=\"group\" aria-label=\"筛选反馈\">"), "反馈的筛选不是 .zq-seg");
        assertEquals(3, html.split("<span class=\"zq-seg-count zq-num\"></span>", -1).length - 1, "三个筛选按钮各有一格个数");
        String css = css();
        assertTrue(css.contains(".zq-reviews{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;align-items:start;}"),
                "共享计划同一行的卡片被拉成一样高（矮的那张下面空一大块）");
        assertTrue(css.contains("white-space:normal;overflow-wrap:anywhere;") && css.contains(".zq-review-title{"),
                "审核卡片的标题按钮不换行：全局给按钮 white-space:nowrap，一串没有空格的标题把整页撑宽");
    }

    @Test
    @DisplayName("落地页标题：两行平衡；宽屏只在标点、空格处断（不断在「每一天 / 的事」），手机上不用 keep-all（不让「，」跑到行首）")
    void 落地页标题() throws IOException {
        String home = read("index.html");
        assertTrue(home.contains("max-width:16em;text-wrap:balance;}"), "标题没有平衡两行（原来「可控」一个人一行）");
        assertTrue(home.contains("@media (min-width:561px){ .zq-hero h1{word-break:keep-all;} }"), "keep-all 不是只给宽屏");
        Matcher h1 = Pattern.compile("\\.zq-hero h1\\{([^}]*)\\}").matcher(home);
        assertTrue(h1.find() && !h1.group(1).contains("keep-all"), "手机上也 keep-all 了：320 宽时一行放不下，被强行断开，「，」跑到行首");
        // 第八十轮（桌面应用里看到的）：WebKit 在 keep-all 下不在全角逗号后面断，整句「帮你把每一天的事，排得清晰可控」连成一块，「让 AI」一个人一行
        assertTrue(home.contains("<h1>让 AI 帮你把每一天的事，<wbr>排得清晰可控</h1>"), "逗号后面要给一个能断的地方（<wbr>）");
    }
}
