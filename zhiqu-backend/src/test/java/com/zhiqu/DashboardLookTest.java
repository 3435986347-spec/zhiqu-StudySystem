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
 * 界面打磨第 5 步（第四十八轮，docs/ui-plan.md）：看板。日历、清单、四象限、临近截止的画法在 dashboard-check.js 里真跑；
 * 这里管静态的那一半：卡片里没有小字标题、「逾期未完」不写死大红、日历一排七格不横向滚、选中的那天重新取数据之后还在。
 */
class DashboardLookTest {

    private static final Path STATIC = Path.of("src/main/resources/static");

    private static String read(String rel) throws IOException {
        return Files.readString(STATIC.resolve(rel), StandardCharsets.UTF_8);
    }

    @Test
    @DisplayName("日历、清单、四象限、临近截止（在 node 里真跑 dashboard.js 那几个函数）")
    void 画法() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/dashboard-check.js"), STATIC.resolve("assets/pages/dashboard.js")),
                "dashboard-check.js 没有全绿");
    }

    @Test
    @DisplayName("卡片标题上面不再有小字（「本周日历」「今天」「象限摘要」「临近 DDL」）；「逾期未完」不写死大红，大于 0 才在标签旁边一个红点")
    void 看板的静态部分() throws IOException {
        String html = read("dashboard.html").replaceAll("(?s)<!--.*?-->", "");
        int main = html.indexOf("<main class=\"zq-main\"");
        assertTrue(main > 0, "找不到 .zq-main");
        String body = html.substring(main);
        assertFalse(body.contains("zq-eyebrow"), "看板的卡片标题上面又有小字");
        assertTrue(body.contains("<article class=\"zq-stat\" id=\"zq-stat-overdue\"><span class=\"zq-stat-label\">逾期未完</span><strong class=\"zq-stat-num\">—</strong></article>"),
                "「逾期未完」那张卡又写死了颜色（原来大红字，0 也红）");
        String js = SourceText.stripComments(SourceText.pageModule("dashboard.js"));
        assertTrue(js.contains("overdueCard.classList.toggle('is-alert', (sum.overdue || 0) > 0);"), "逾期大于 0 时没有标出来");
        String css = SourceText.stripComments(read("assets/zhiqu-ui.css"));
        assertTrue(css.contains(".zq-stat.is-alert .zq-stat-label::after{") && css.contains("background:var(--zq-bad);}"), "逾期的红点没有样式");
        assertTrue(body.contains("<div id=\"zq-week\" class=\"zq-week\"></div>"), "日历的容器又写回内联样式了");
        assertTrue(css.contains(".zq-week{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));"), "日历一排七格要挤得下（原来每格 108px 起、窄了就横向滚）");
        assertTrue(js.contains("if (keep) showDay(keep);"), "重新取数据之后（记完番茄钟、跨过零点）选中的那天没有保住");
        // 暴力测试照出来的两处（第四十八轮）：换过周再回到本周时一格都没选中；连点上一周 / 下一周时回来晚的那次盖掉了最后一次
        assertTrue(js.contains("state.dashDay = keep;"), "选的那天不在这一周时没清掉 —— 回到本周一格都没选中");
        String boot = SourceText.functionBody(js, "async function bootDashboard()");
        int seq = boot.indexOf("var seq = state.dashSeq = (state.dashSeq || 0) + 1;");
        int get = boot.indexOf("await api.get('/dashboard/overview");
        int guard = boot.indexOf("if (seq !== state.dashSeq) { await pomo; return; }");
        assertTrue(seq > 0 && get > seq && guard > get, "连点换周时没有只画最后一次的（回来晚的会盖掉最后一次）");
    }
}
