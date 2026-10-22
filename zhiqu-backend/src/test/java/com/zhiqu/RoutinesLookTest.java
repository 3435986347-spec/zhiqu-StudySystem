package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 界面打磨第 8 步（一）（第五十六轮，docs/ui-plan.md）：例行计划页。
 *
 * <p>原来页面从上到下是「从任务生成」一大块、「新建」表单、（右下半边）「我的例行计划」—— 31 个计划在 1440 宽时第一屏只露出四条；
 * 两张表单各问各的（新建的那张选不了星期、时间）；「标记完成」不管今天轮不轮到都给；打过卡的看不出来。现在页面只放「今天」和「全部例行计划」，
 * 新建和从任务生成是页头的两个弹窗、同一套设置。行为在 routines-check.js 里真跑（import 发布的模块）；这里管页面和样式的静态那一半。
 */
class RoutinesLookTest {

    private static final Path STATIC = Path.of("src/main/resources/static");

    @Test
    @DisplayName("行为（node 里真跑 pages/routines.js）：今天按打卡状态画、全部的排序、设置读出来的提交内容、两个弹窗的连点和失败、完成 / 删除走 safe、零点只取数据")
    void 行为() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/routines-check.js"), NodeRunner.API_JS), "routines-check.js 没有全绿");
    }

    @Test
    @DisplayName("页面：页头右边「从任务生成」（次）+「新建例行计划」（主）；只有「今天」「全部例行计划」两块；标题上面没有小字；没有内联样式")
    void 页面() throws IOException {
        String html = Files.readString(STATIC.resolve("routines.html"), StandardCharsets.UTF_8).replaceAll("(?s)<!--.*?-->", "");
        String main = html.substring(html.indexOf("<main class=\"zq-main\""), html.indexOf("</main>"));
        assertTrue(main.contains("<div class=\"zq-page-actions\"><button type=\"button\" class=\"zq-btn-ghost\" id=\"zq-rt-from-tasks\">从任务生成</button>"
                + "<button type=\"button\" class=\"zq-btn\" id=\"zq-rt-new\">新建例行计划</button></div>"), "页头右边不是「从任务生成」+「新建例行计划」");
        assertTrue(main.contains("<h2 class=\"zq-h2\">今天</h2>") && main.contains("<div class=\"zq-agenda\" id=\"zq-rt-today\"></div>"), "没有「今天」那一块");
        assertTrue(main.contains("<h2 class=\"zq-h2\">全部例行计划</h2>") && main.contains("<div class=\"zq-rt-list\" id=\"zq-rt\"></div>"), "没有「全部例行计划」那一块");
        assertFalse(main.contains("zq-eyebrow"), "标题上面又压着小字（「从任务生成」「新建」「进行中」）");
        assertFalse(main.contains("<input") || main.contains("<select") || main.contains("<textarea"), "页面上又常驻了表单 —— 新建和从任务生成是弹窗");
        assertFalse(main.contains("style="), "例行计划页又写了内联样式");
    }

    @Test
    @DisplayName("模块只管类和 aria-*：不拼内联样式、不在 JS 里改样子（星期按钮、分段按下的样子在样式表）")
    void 模块不写样子() throws IOException {
        String js = SourceText.pageModule("routines.js");
        assertTrue(js.length() > 4000, "routines.js 只读到 " + js.length() + " 字 —— 读错文件了？");
        assertFalse(js.contains("style="), "routines.js 又在拼内联样式");
        assertFalse(js.contains(".style."), "routines.js 又在 JS 里改样子（按下的样子靠 aria-pressed，样式表里画）");
        String css = Files.readString(STATIC.resolve("assets/zhiqu-ui.css"), StandardCharsets.UTF_8);
        assertTrue(css.contains(".zq-rt-days .zq-chip[aria-pressed=\"true\"]{"), "选上的星期没有按下的样子（.zq-chip 默认按下是浅灰底，七个里分不清）");
        assertTrue(css.contains(".zq-rt-row:hover .zq-rt-acts,.zq-rt-row:focus-within .zq-rt-acts{opacity:1;}"), "删除按钮悬停 / 键盘移到时不出现");
        String phone = css.substring(css.lastIndexOf("@media (max-width: 760px)"));
        assertTrue(phone.contains(".zq-rt-acts{opacity:1;}") || phone.contains(",.zq-rt-acts{opacity:1;}"), "手机上删除按钮看不见（没有悬停）");
    }
}
