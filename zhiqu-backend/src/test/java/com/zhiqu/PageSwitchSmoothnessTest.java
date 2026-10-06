package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 页面切换流畅（第三十九轮，用户 2026-10-05：「页面切换非常不流畅」）。实测见 docs/rounds/round-39.md：
 * 原来每切一次页面都是「主内容区空白 → 淡入」，AI 助手空白 0.8～1.3 秒；每页还从 Google Fonts 取一个挡渲染、挡脚本的样式表，
 * 这台机器的网络上没缓存时一次 1.3～2.7 秒。
 */
class PageSwitchSmoothnessTest {

    private static final Path STATIC = Path.of("src/main/resources/static");

    private static String read(Path p) throws IOException {
        return Files.readString(p, StandardCharsets.UTF_8);
    }

    private static List<Path> pages() throws IOException {
        try (Stream<Path> list = Files.list(STATIC)) {
            return list.filter(p -> p.toString().endsWith(".html")).sorted().collect(Collectors.toList());
        }
    }

    @Test
    @DisplayName("外壳（在 node 里真跑 zhiqu-ui.js）：只有后台页和旧地址的跳转页先遮住主内容区；左下角的名字按令牌接着画、转义；侧栏的收起按钮、两侧面板的开关只是图标、有名字")
    void 骨架不遮() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/ui-shell-check.js"), STATIC.resolve("assets/zhiqu-ui.js")),
                "ui-shell-check.js 没有全绿");
    }

    @Test
    @DisplayName("没有页面再从外网取字体或样式表：挡渲染、挡脚本，网络慢时整页等着")
    void 不取外网字体() throws IOException {
        List<Path> files = new ArrayList<>(pages());
        try (Stream<Path> walk = Files.walk(STATIC.resolve("assets"))) {
            walk.filter(p -> p.toString().endsWith(".js") || p.toString().endsWith(".css"))
                    .filter(p -> !p.toString().contains("/vendor/")).forEach(files::add);
        }
        assertTrue(files.size() >= 25, "只扫到 " + files.size() + " 个文件");
        List<String> found = new ArrayList<>();
        Pattern external = Pattern.compile("fonts\\.googleapis\\.com|fonts\\.gstatic\\.com|<link[^>]+rel=\"(?:stylesheet|preconnect)\"[^>]+href=\"https?://|<link[^>]+href=\"https?://[^\"]+\"[^>]+rel=\"stylesheet\"");
        for (Path f : files) {
            Matcher m = external.matcher(read(f));
            while (m.find()) found.add(STATIC.relativize(f) + "：" + m.group());
        }
        assertEquals(List.of(), found, "页面又从外网取字体 / 样式表了");
    }

    @Test
    @DisplayName("文字一律系统无衬线字体（用户定的）；数字用等宽数位，等宽字体只给代码")
    void 系统无衬线() throws IOException {
        String css = SourceText.stripComments(read(STATIC.resolve("assets/zhiqu-ui.css")));
        Matcher body = Pattern.compile("--zq-fontBody:([^;]+);").matcher(css);
        assertTrue(body.find(), "找不到 --zq-fontBody");
        String stack = body.group(1);
        assertTrue(stack.trim().endsWith("sans-serif"), "正文字体栈最后要落在 sans-serif：" + stack);
        assertFalse(Pattern.compile("(?i)serif\\s*sc|song|simsun|stsong|kaiti|fangsong|(?<!sans-)\\bserif\\b").matcher(stack).find(),
                "正文字体栈里又有衬线字体：" + stack);
        assertTrue(stack.contains("PingFang SC") && stack.contains("Microsoft YaHei"), "苹方（macOS）、微软雅黑（Windows）要在字体栈里：" + stack);
        assertTrue(css.contains(".zq-num{font-family:var(--zq-fontBody);font-variant-numeric:tabular-nums;}"), "数字的样式（正文字体 + 等宽数位）不见了");
        Matcher stat = Pattern.compile("\\.zq-stat-num\\{([^}]*)\\}").matcher(css);
        assertTrue(stat.find(), "找不到 .zq-stat-num");
        assertFalse(stat.group(1).contains("--zq-fontM"), "看板的大数字又用回了等宽字体（看着像终端）");
        assertTrue(stat.group(1).contains("tabular-nums"), "看板的大数字要等宽数位");
    }

    @Test
    @DisplayName("页面的内容外壳不再淡入上滑：每切一次页面都慢 0.3 秒")
    void 不淡入() throws IOException {
        List<String> found = new ArrayList<>();
        int mains = 0;
        for (Path p : pages()) {
            String html = read(p);
            int at = html.indexOf("<main class=\"zq-main\"");
            int wrapper = at < 0 ? -1 : html.indexOf("<div", at);
            if (wrapper < 0) continue;   // 没有 .zq-main 的（落地页）和里面没有内容的（旧地址的跳转页）
            mains++;
            int end = html.indexOf('>', wrapper);
            if (html.substring(at, end).contains("zqFadeIn")) found.add(p.getFileName().toString());
        }
        assertTrue(mains >= 10, "只找到 " + mains + " 个页面有 .zq-main");
        assertEquals(List.of(), found, "这些页面的内容外壳又带上了淡入动画");
    }

    @Test
    @DisplayName("页面之间交叉淡化、侧栏不动（不认的浏览器照常整页切换）")
    void 切换过渡() throws IOException {
        String css = SourceText.stripComments(read(STATIC.resolve("assets/zhiqu-ui.css")));
        assertTrue(css.contains("@view-transition{navigation:auto;}"), "页面之间的过渡没开");
        assertTrue(css.contains(".zq-side{view-transition-name:zq-side;}"), "侧栏没有单独成组 —— 切页面时它会跟着淡化");
        assertTrue(css.contains("::view-transition-group(zq-side),::view-transition-old(zq-side),::view-transition-new(zq-side){animation:none;}"),
                "侧栏切换时不该有动画");
        assertTrue(css.contains("@media (prefers-reduced-motion:reduce){::view-transition-group(*)"), "系统设了「减少动态效果」时要关掉切换动画");
    }

    @Test
    @DisplayName("互不依赖的请求一起发：看板（总览 + 番茄钟两块）、专注统计（总数 + 趋势）、AI 助手（记录 + 执行轨迹）")
    void 请求并行() throws IOException {
        String board = SourceText.functionBody(SourceText.pageModule("dashboard.js"), "async function bootDashboard()");
        int pomo = board.indexOf("var pomo = Promise.all([populatePomoTasks(), updatePomoCount()]);");
        int overview = board.indexOf("await api.get('/dashboard/overview");
        assertTrue(pomo > 0 && overview > pomo, "看板：番茄钟那两块要在等总览之前就发出去");
        assertTrue(board.contains("await pomo;") && !board.contains("await populatePomoTasks();") && !board.contains("await updatePomoCount();"),
                "看板：番茄钟那两块又排回总览后面一个一个等了");

        String stats = SourceText.functionBody(SourceText.pageModule("statistics.js"), "async function bootStatistics()");
        int trend = stats.indexOf("var trend = paintTrend('day');");
        int stat = stats.indexOf("await api.get('/record/statistics')");
        assertTrue(trend > 0 && stat > trend && stats.contains("await trend;"), "专注统计：趋势要在等总数之前就发出去");
        assertTrue(stats.contains("trend.catch(function () {});"), "专注统计：总数先失败时，趋势的失败没人接（会多弹一句）");

        String ai = SourceText.functionBody(SourceText.pageModule("ai-assistant.js"), "async function bootAiAssistant()");
        assertTrue(ai.contains("\n  await Promise.all([loadAiMessages(), renderAgentPanels()]);\n"), "AI 助手：聊天记录和执行轨迹要一起取");
        assertFalse(ai.contains("\n  await renderAgentPanels();\n"), "AI 助手：执行轨迹又排到聊天记录后面了");
    }

    @Test
    @DisplayName("AI 助手跟着底部时，公式排完、图片到了也留在底部；用户往上翻了就不动他")
    void 留在底部() throws IOException {
        String code = SourceText.pageModule("ai-assistant.js");
        assertTrue(SourceText.functionBody(code, "function renderAiMessages(opts)").contains("keepPinned(host);"), "画完消息没有接上「留在底部」");
        String pin = SourceText.functionBody(code, "function keepPinned(host)");
        assertTrue(pin.contains("new ResizeObserver(") && pin.contains("pinObserver.observe(row)"), "没有盯着每一条消息的高度");
        assertTrue(pin.contains("if (chat && state.chatFollow) chat.scrollTop = chat.scrollHeight;"),
                "只有跟着底部时才拉回底部 —— 用户往上翻着看的时候不能把他拽下来");
    }
}
