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
 * 界面打磨第 8 步（二）（第五十七轮，docs/ui-plan.md）：专注统计页。
 *
 * <p>原来每一根柱子上都写数（零也写）、零是一道灰线、有数的也是浅灰；「日 / 周 / 月」按下是 JS 改背景色；两张卡一高一矮；
 * 窄的时候（最窄的桌面窗口、手机）十四根柱子底下的日期被截成「9/」「10」。画法在 statistics-check.js 里真跑；这里管静态的那一半。
 */
class StatisticsLookTest {

    private static final Path STATIC = Path.of("src/main/resources/static");

    @Test
    @DisplayName("画法（node 里真跑 pages/statistics.js）：零不写数、有数的写、高度交给 --v、悬停说明、按下用 aria-pressed、图例")
    void 画法() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/statistics-check.js"), NodeRunner.API_JS), "statistics-check.js 没有全绿");
    }

    @Test
    @DisplayName("页面：日 / 周 / 月是 .zq-seg（aria-pressed），手机上数字两个一排、两张卡一上一下；没有内联样式")
    void 页面() throws IOException {
        String html = Files.readString(STATIC.resolve("statistics.html"), StandardCharsets.UTF_8).replaceAll("(?s)<!--.*?-->", "");
        String main = html.substring(html.indexOf("<main class=\"zq-main\""), html.indexOf("</main>"));
        assertTrue(main.contains("<div class=\"zq-seg\" id=\"zq-tabs\" role=\"group\" aria-label=\"按日 / 周 / 月看\"><button type=\"button\" data-k=\"day\" aria-pressed=\"true\">日</button>"),
                "日 / 周 / 月不是分段（或者默认按下的不是「日」）");
        assertTrue(main.contains("<section class=\"zq-grid zq-stat-grid zq-phone-2col\">"), "手机上四个数字没说怎么排（两个一排）");
        assertTrue(main.contains("<div class=\"zq-stats-cols zq-phone-1col\">"), "手机上两张卡没说怎么排（一上一下）");
        assertFalse(main.contains("style="), "专注统计页又写了内联样式");
    }

    @Test
    @DisplayName("样式：柱子挤的时候隔一根写一个日期（不截断）；两张卡一样高；模块不在 JS 里改样子")
    void 样式() throws IOException {
        String css = Files.readString(STATIC.resolve("assets/zhiqu-ui.css"), StandardCharsets.UTF_8);
        assertTrue(css.contains("container-type:inline-size;}") && css.contains(".zq-bars{flex:1;"), "柱子那一块不是容器，下面的容器查询不生效");
        int q = css.indexOf("@container (max-width: 460px){");
        assertTrue(q > 0 && css.substring(q, css.indexOf("}\n}", q)).contains(".zq-bar:nth-child(even) .zq-bar-label{visibility:hidden;}"),
                "柱子挤的时候没有隔一根写日期 —— 「10/10」会被截成「10」");
        assertTrue(css.contains(".zq-stats-cols{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(280px,1fr);gap:16px;}"),
                "两张卡的网格变了（不写 align-items 才是两张一样高）");
        String js = SourceText.pageModule("statistics.js");
        assertFalse(js.contains(".style."), "statistics.js 又在 JS 里改样子（按下的样子靠 aria-pressed）");
    }
}
