package com.zhiqu.cli;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 终端里的 Markdown 渲染（P0-3）。用户原话：「CLI 为什么还要输出 Markdown，要么渲染后输出，要么就输出纯文本」。
 * 这些输入取自用户贴回来的真实回答（马里奥小游戏那一轮的表格、步骤、代码块）。
 */
class CliMarkdownTest {

    private static final class Sink {
        final ByteArrayOutputStream buf = new ByteArrayOutputStream();
        final CliMarkdown md;

        Sink(boolean color) {
            md = new CliMarkdown(new PrintStream(buf, true, StandardCharsets.UTF_8), color);
        }

        String out() {
            return buf.toString(StandardCharsets.UTF_8);
        }
    }

    private static String plain(String... deltas) {
        Sink s = new Sink(false);
        for (String d : deltas) s.md.feed(d);
        s.md.finish();
        return s.out();
    }

    @Test
    @DisplayName("纯文本模式：标题、加粗、行内代码、表格分隔行的标记全部去掉，结构保留")
    void 纯文本不留标记() {
        // 加粗要同时出现在「段落」（流式状态机）和「列表 / 表格」（按行渲染）里 —— 两条路径各一份实现。
        // 第一版只在段落里放了加粗，把列表 / 表格那条路改成保留 ** 时这条照样绿（扰动 M4 照出来的）。
        String out = plain("## 最小可行版本\n\n先用最简单的：**HTML Canvas** 加 `原生 JavaScript`。\n\n"
                + "- **重点**：先让小人能跳\n"
                + "| 模块 | 内容 |\n| --- | --- |\n| 角色 | **必须** |\n");
        assertTrue(out.contains("  • 重点：先让小人能跳"), out);
        assertTrue(out.contains("最小可行版本"), out);
        assertTrue(out.contains("先用最简单的：HTML Canvas 加 原生 JavaScript。"), out);
        for (String marker : List.of("##", "**", "`", "| ---", "|---")) {
            assertFalse(out.contains(marker), "纯文本里还留着 Markdown 标记「" + marker + "」：\n" + out);
        }
    }

    /** 中文一个字占两格：按字符数对齐的话，中英混排的表格会歪。 */
    @Test
    @DisplayName("表格按列对齐：每一行的列分隔符落在同一个显示列上（中文算两格）")
    void 表格对齐() {
        String out = plain("| 功能 | 说明 |\n| --- | --- |\n| 画布 | 一个网页游戏区域 |\n| 重新开始 | 按 R 键 |\n| Esc | 暂停 |\n");
        List<String> rows = out.lines().filter(l -> l.contains("│")).toList();
        assertEquals(4, rows.size(), "表格行数不对：\n" + out);
        // 用判据自己的尺子量，不用 CliMarkdown.displayWidth —— 拿被测函数当裁判的话，
        // 它把中文算成一格时两边一起错、照样对得上（扰动 M2 照出来的）
        int col = cells(rows.get(0).substring(0, rows.get(0).indexOf('│')));
        for (String r : rows) {
            assertEquals(col, cells(r.substring(0, r.indexOf('│'))), "这一行的分隔符歪了：「" + r + "」\n" + out);
        }
        assertTrue(out.contains("─┼─"), "表头与内容之间应当有一条分隔线：\n" + out);
    }

    /** 独立的显示宽度：中日韩统一表意文字与全角标点算两格，其余一格。 */
    private static int cells(String s) {
        int w = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            w += (c >= '\u4e00' && c <= '\u9fff') || (c >= '\uff00' && c <= '\uffef') || (c >= '\u3000' && c <= '\u303f') ? 2 : 1;
        }
        return w;
    }

    @Test
    @DisplayName("代码块加框并标出语言；列表换成圆点、编号保留")
    void 代码块与列表() {
        String out = plain("```html\n<canvas id=\"c\"></canvas>\n```\n- 打开方式：双击\n1. 第一步\n");
        assertTrue(out.contains("┌─ html\n│ <canvas id=\"c\"></canvas>\n└─\n"), out);
        assertTrue(out.contains("  • 打开方式：双击"), out);
        assertTrue(out.contains("  1. 第一步"), out);
    }

    /** 模型的增量是任意切的：「**」完全可能被拆成两次到达。 */
    @Test
    @DisplayName("流式：加粗标记被拆在两次增量之间也渲染正确")
    void 拆开的加粗() {
        assertEquals("这是加粗的字\n", plain("这是*", "*加", "粗*", "*的字\n"));
        Sink s = new Sink(true);
        s.md.feed("这是*");
        s.md.feed("*加粗**的字\n");
        s.md.finish();
        assertTrue(s.out().contains("\u001b[1m加粗\u001b[22m"), "终端模式下加粗没渲染：" + s.out());
    }

    /** 段落不能等到换行才出：一段话可能要流好几十秒，攒着不出就又是「卡住了」。 */
    @Test
    @DisplayName("流式：普通段落不等换行就边收边出；表格要等整块收齐")
    void 段落边收边出() {
        Sink s = new Sink(false);
        s.md.feed("这是一段很长的回答，还没有换行");
        assertTrue(s.out().contains("这是一段很长的回答"), "段落在等换行 —— 用户会以为卡住了：「" + s.out() + "」");
        Sink t = new Sink(false);
        t.md.feed("| a | b |\n| --- | --- |\n");
        assertFalse(t.out().contains("a"), "表格没收齐就开始输出了，没法按列对齐");
        t.md.finish();
        assertTrue(t.out().contains("a"), "流结束时没把攒着的表格吐出来");
    }

    /** 渲染器对了还不够：回答正文要真的交给它。原样打印的话上面每一条都绿，终端里照样是原文。 */
    @Test
    @DisplayName("接线：CliRenderer 把回答正文交给 Markdown 渲染器，结束时收尾")
    void 回答走渲染器() throws Exception {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        CliRenderer r = new CliRenderer(new PrintStream(buf, true, StandardCharsets.UTF_8), false);
        com.fasterxml.jackson.databind.ObjectMapper json = new com.fasterxml.jackson.databind.ObjectMapper();
        r.onEvent("message.delta", json.readTree("{\"text\":\"## 做好了\\n| a | b |\\n| --- | --- |\\n| 1 | 2 |\"}"));
        r.onEvent("done", json.readTree("{\"status\":\"DONE\"}"));
        String out = buf.toString(StandardCharsets.UTF_8);
        assertTrue(out.contains("做好了") && !out.contains("##"), "标题没渲染：" + out);
        assertTrue(out.contains("│") && !out.contains("| ---"), "表格没渲染（或 done 时没收尾吐出来）：" + out);
    }

    @Test
    @DisplayName("终端模式：标题加粗、行内代码上色；链接留下地址")
    void 终端渲染() {
        Sink s = new Sink(true);
        s.md.feed("# 标题\n- 运行 `node a.js`\n看 [文档](https://example.com)\n");
        s.md.finish();
        String out = s.out();
        assertTrue(out.contains("\u001b[1m标题\u001b[0m"), out);
        assertTrue(out.contains("\u001b[36mnode a.js\u001b[0m"), out);
        assertTrue(out.contains("文档") && out.contains("https://example.com"), out);
        assertFalse(out.contains("# 标题") || out.contains("`"), "终端模式下还有原始标记：" + out);
    }
}
