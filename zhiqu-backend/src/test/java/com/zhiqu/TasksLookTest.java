package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 界面打磨第 6 步（第五十二轮，docs/ui-plan.md）：任务页。工具条和行的画法在 tasks-check.js 里真跑 tasks.js；
 * 这里管静态的那一半：不再有五个下拉 +「查询」+ 手调的绿色按钮；列宽只在样式表里写一处；编辑 / 删除悬停或键盘移到时出现、手机上一直在；
 * 最窄的桌面窗口里表格不横着滚（原来最少 880px，编辑 / 删除滚出去看不见）。服务端的关键词搜索见 LargeAccountIntegrationTest。
 */
class TasksLookTest {

    private static final Path STATIC = Path.of("src/main/resources/static");

    private static String read(String rel) throws IOException {
        return Files.readString(STATIC.resolve(rel), StandardCharsets.UTF_8);
    }

    @Test
    @DisplayName("工具条与行（在 node 里真跑 tasks.js）：条件 → 参数、「筛选」上的数、时间写短、一行的样子、只认最后一次的搜索、没有结果时的两种说法")
    void 画法() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/tasks-check.js"), STATIC.resolve("assets/pages/tasks.js")), "tasks-check.js 没有全绿");
    }

    @Test
    @DisplayName("页面：一行工具条（搜索、状态分段、筛选），没有「查询」、没有手调的绿色按钮；「新建任务」是页头的主按钮；表头和行都用 .zq-task-grid")
    void 页面() throws IOException {
        String html = read("tasks.html").replaceAll("(?s)<!--.*?-->", "");
        String main = html.substring(html.indexOf("<main class=\"zq-main\""));
        assertFalse(main.contains(">查询<"), "还有「查询」按钮 —— 条件改了就该查");
        assertFalse(main.contains("var(--zq-ok)"), "还有手调颜色的按钮（原来「新建任务」是绿色描边，绿色在这里没有意思）");
        assertTrue(main.contains("<div class=\"zq-page-actions\"><button type=\"button\" class=\"zq-btn\" id=\"zq-task-new\">"), "「新建任务」不是页头的主按钮");
        assertTrue(main.contains("<input type=\"search\" id=\"zq-task-q\""), "没有搜索框");
        Matcher seg = Pattern.compile("data-status=\"(\\d?)\"").matcher(main);
        StringBuilder statuses = new StringBuilder();
        while (seg.find()) statuses.append('[').append(seg.group(1)).append(']');
        assertEquals("[][0][1][2]", statuses.toString(), "状态分段应当是 全部 / 待办 / 进行中 / 已完成");
        assertTrue(main.contains("<div class=\"zq-task-filters\" id=\"zq-task-filters\" hidden>"), "不常用的条件（象限、优先级、排序）平时收着");
        assertTrue(main.contains("<div class=\"zq-thead zq-task-grid\">"), "表头不是 .zq-task-grid");
        assertFalse(main.contains("grid-template-columns"), "页面里又写死列宽了");
        // 服务端：/task/page 认 keyword 并交给服务（服务里怎么找见 LargeAccountIntegrationTest）
        String controller = SourceText.stripComments(Files.readString(Path.of("src/main/java/com/zhiqu/controller/StudyTaskController.java"), StandardCharsets.UTF_8));
        String page = controller.substring(controller.indexOf("@GetMapping(\"/page\")"), controller.indexOf("@GetMapping(\"/quadrant\")"));
        assertTrue(page.contains("@RequestParam(required = false) String keyword") && page.contains("sortBy, sortOrder, keyword, offset, limit)"),
                "/task/page 没接 keyword、或者没交给服务 —— 搜索框打了字也是全部：\n" + page);
        String js = SourceText.pageModule("tasks.js");
        assertFalse(js.contains("grid-template-columns") || js.contains("style="), "任务页的模块又在拼内联样式（列宽只在样式表里写一处）");
    }

    @Test
    @DisplayName("样式：列宽只定义一次、最窄的桌面窗口里不横着滚；编辑 / 删除悬停或键盘移到这一行时出现，手机上一直在、一行叠成两三行不横着滚")
    void 样式() throws IOException {
        String css = SourceText.stripComments(read("assets/zhiqu-ui.css"));
        // 只数单独的 .zq-task-grid{（手机那段里的 .zq-task-line.zq-task-grid / .zq-thead.zq-task-grid 是另一回事）
        Matcher grid = Pattern.compile("(?<![\\w-])\\.zq-task-grid\\{").matcher(css);
        int grids = 0;
        while (grid.find()) grids++;
        assertEquals(1, grids, ".zq-task-grid 应该恰好定义一次（列宽只写一处）");
        Matcher min = Pattern.compile("\\.zq-task-scroll\\{min-width:(\\d+)px;\\}").matcher(css);
        assertTrue(min.find(), "找不到 .zq-task-scroll 的最小宽度");
        // 桌面应用最窄 960（ZhiquShell.swift 的 minSize），那时正文里表格实测 680 宽：比它宽就横着滚、编辑 / 删除在右边看不见
        assertTrue(Integer.parseInt(min.group(1)) <= 680, "表格最小 " + min.group(1) + "px —— 最窄的桌面窗口里要横着滚");
        assertTrue(css.contains(".zq-task-line:hover .zq-task-acts,.zq-task-line:focus-within .zq-task-acts{opacity:1;}"),
                "编辑 / 删除只在悬停时出现、键盘移过去看不见");
        int media = css.indexOf("@media (max-width: 760px){");
        assertTrue(media > 0 && css.indexOf(".zq-task-acts{opacity:1;}", media) > 0, "手机上没有悬停：编辑 / 删除要一直在");
        // 手机上一行不是一排格子：横着滚的话状态、时间、编辑删除都在屏幕外（第五十二轮暴力测试照出来的）
        assertTrue(css.indexOf(".zq-task-line.zq-task-grid{display:flex;flex-wrap:wrap;", media) > 0 && css.indexOf(".zq-task-scroll{min-width:0;}", media) > 0,
                "手机上任务的一行还是一排要横着滚的格子");
    }
}
