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
 * 界面打磨第 8 步（二）（第五十七轮，docs/ui-plan.md）：参考计划页。
 *
 * <p>原来筛选是三个带小标题的下拉（分类、排序、方向）+「刷新」；分类是彩色底的牌子；点赞是字符；详情是 HTML 里另写的一套弹窗
 * （分类显示成代码「GENERAL」，点赞之后整页重跑启动、列表回到默认）；套用弹一个文字框让人手打日期。行为在 shared-plans-check.js 里真跑；这里管静态的那一半。
 */
class SharedPlansLookTest {

    private static final Path STATIC = Path.of("src/main/resources/static");

    @Test
    @DisplayName("行为（node 里真跑 pages/shared-plans.js）：卡片、详情、我的投稿、排序、点赞后照原筛选重新取、套用带键带日期且不重发")
    void 行为() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/shared-plans-check.js"), NodeRunner.API_JS), "shared-plans-check.js 没有全绿");
    }

    @Test
    @DisplayName("页面：一行工具条（分类、排序两个下拉，有 aria-label，没有「方向」「刷新」）；没有写死的详情弹窗；没有内联样式")
    void 页面() throws IOException {
        String html = Files.readString(STATIC.resolve("shared-plans.html"), StandardCharsets.UTF_8).replaceAll("(?s)<!--.*?-->", "");
        String main = html.substring(html.indexOf("<main class=\"zq-main\""), html.indexOf("</main>"));
        assertTrue(main.contains("<select class=\"zq-select\" id=\"zq-plan-cat\" aria-label=\"分类\">"), "没有分类下拉（或者没有 aria-label —— 去掉小标题之后靠它读出来）");
        assertTrue(main.contains("<select class=\"zq-select\" id=\"zq-plan-sort\" aria-label=\"排序\"><option value=\"time:desc\">最新发布</option>"), "排序下拉不是「最新发布 / 最早发布 / 赞最多」那一个");
        assertFalse(main.contains(">刷新<") || main.contains(">方向<") || main.contains("zq-label"), "工具条又有了「刷新」「方向」或者小标题");
        assertFalse(html.contains("id=\"zq-modal\"") || html.contains("data-close-modal"), "HTML 里又写了一套详情弹窗 —— 详情用 openModal");
        assertFalse(main.contains("style="), "参考计划页又写了内联样式");
    }

    @Test
    @DisplayName("模块只管类和 aria-*：不拼内联样式、不在 JS 里改样子；详情用 openModal")
    void 模块不写样子() throws IOException {
        String js = SourceText.pageModule("shared-plans.js");
        assertTrue(js.length() > 4000, "shared-plans.js 只读到 " + js.length() + " 字 —— 读错文件了？");
        assertFalse(js.contains("style="), "shared-plans.js 又在拼内联样式");
        assertFalse(js.contains(".style."), "shared-plans.js 又在 JS 里改样子");
        assertTrue(SourceText.functionBody(js, "async function openPlan(").contains("openModal({"), "详情不是用 openModal 打开的");
        String css = Files.readString(STATIC.resolve("assets/zhiqu-ui.css"), StandardCharsets.UTF_8);
        assertTrue(css.contains(".zq-plan-like[aria-pressed=\"true\"]{"), "点了赞没有按下的样子");
        assertTrue(css.contains(".zq-plan-card:focus-visible{"), "键盘移到卡片上看不出来");
    }
}
