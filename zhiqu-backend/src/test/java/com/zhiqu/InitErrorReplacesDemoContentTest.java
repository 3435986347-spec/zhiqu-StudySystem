package com.zhiqu;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 页面里不放示例数据；页面加载失败时整块换成错误卡片。
 *
 * <h2>由来</h2>
 *
 * <p>14 个页面里原来有 12 个内联了一段脚本，在应用脚本加载<b>之前</b>就把一批编造的学习数据写进 DOM ——
 * 「2027 考研总目标」「数学薄弱点清单」「番茄钟记录」之类，静态 HTML 里还写着「共 1,284 个账号」「第 17 教学周」。
 * 挡住它们的只有一处：boot 失败时 {@link #INIT_ERROR} 把整个 {@code .zq-main} 换成错误卡片。而 boot <b>成功</b>时
 * 没被重绘的那部分照样露出来 ——「已审核模板 · 4 个」「第 3 轮」「例行完成 60%」都是这么上线的（2026-10-01、10-03）。
 *
 * <p>第二十四轮（2026-10-04）把示例数据删了：内联脚本只剩主题初始化那一行和看板的番茄钟；示例脚本顺带画出来的真控件
 * （统计页的日 / 周 / 月、成就页的筛选、例行计划的星期）挪进了静态 HTML。这里钉两件事：不许再长回来；
 * 加载失败时照旧整块替换 —— 示例数据没了，但一个画了一半的页面同样会误导人。
 */
class InitErrorReplacesDemoContentTest {
    private static final Path STATIC_DIR = Path.of("src/main/resources/static");
    private static final Path API_JS = STATIC_DIR.resolve("assets/zhiqu-api.js");

    private static final Pattern INLINE_SCRIPT =
            Pattern.compile("(?s)<script(?![^>]*src=)[^>]*>(.*?)</script>");

    private static String apiJs() throws IOException {
        return SourceText.stripComments(Files.readString(API_JS, StandardCharsets.UTF_8));
    }

    /** 名字给 javadoc 引用用。 */
    private static final String INIT_ERROR = "renderInitError";

    /**
     * 加载失败时必须<b>替换</b> {@code .zq-main} 的内容，而不是只提示。
     *
     * <p>扰动：把 {@code main.innerHTML = ...} 改成 {@code toast(...)} → 本条红。
     */
    @Test
    void 加载失败必须替换主内容区而不是只提示() throws IOException {
        String code = apiJs();
        int at = code.indexOf("function " + INIT_ERROR + "(");
        assertTrue(at >= 0, INIT_ERROR + " 不见了 —— 页面加载失败时要整块换成错误卡片");
        String body = code.substring(at, Math.min(code.length(), at + 1200));

        assertTrue(body.contains("$('.zq-main')"),
                "必须定位到 .zq-main：示例数据全部写在它内部（本类另一条判据核过），"
                        + "换别的容器就挡不住了");
        assertTrue(body.contains("main.innerHTML ="),
                "必须整块替换内容。改成只 toast 的话，接口一失败用户就会看到一份"
                        + "不属于自己的学习计划，而且看起来像自己的数据");
    }

    /** boot 出错时必须真的走到那条替换路径上 —— 光有函数、没人调它等于没有。 */
    @Test
    void boot失败必须触发替换() throws IOException {
        String code = apiJs();
        // 第三十七轮起每一页都是模块：启动那一行是 await pageModule.boots[page](zqShared);（原来是壳里的 boots 表）
        assertTrue(code.contains("await pageModule.boots[page](zqShared);"),
                "页面 boot 的调度写法变了，本判据的锚点要跟着改");
        int at = code.indexOf("await pageModule.boots[page](zqShared);");
        String after = code.substring(at, Math.min(code.length(), at + 900));
        assertTrue(after.contains("renderError: true"),
                "boot 必须在 renderError 模式下跑，否则失败时只弹个 toast，"
                        + "而遮罩照样被 finally 里的 revealContent 摘掉 —— 露出来的就是示例数据");
    }

    /**
     * 静态 HTML 里写着的数字，只许是这些说明文字（它们说的是规则，不是某个人的数据）。
     * 加一句带数字的说明时加进这里；加一个写死的统计数、日期、条数时，这条会红 —— 那正是它要拦的。
     */
    private static final List<String> COPY_WITH_DIGITS = List.of(
            "平台运行总览 · 数据每 5 分钟刷新 · 不展示用户任务与知识库正文",
            "近 15 分钟请求量",
            "打开后，任务的提醒时间、截止前提醒和每天 08:00 的待办汇总都推送到下面的渠道",
            "，把它显示的 8 位设备码填在这里。命令行不会拿到你的密码，只拿到一张可随时撤销的令牌。",
            "Anthropic 用 /v1/messages；Ollama 默认 http://localhost:11434/v1/chat/completions。",
            "25:00");   // 番茄钟没开始时的显示（默认 25 分钟），不是数据

    @Test
    void 页面里没有示例数据() throws IOException {
        List<String> found = new ArrayList<>();
        int pages = 0;
        try (Stream<Path> files = Files.list(STATIC_DIR)) {
            for (Path page : files.filter(p -> p.toString().endsWith(".html")).sorted().toList()) {
                String name = page.getFileName().toString();
                // index.html 是落地页（没有 .zq-main）：轮播是产品截图，文案由 PositioningCopyTest 管
                if ("index.html".equals(name)) {
                    continue;
                }
                pages++;
                String html = Files.readString(page, StandardCharsets.UTF_8);
                Matcher scripts = INLINE_SCRIPT.matcher(html);
                while (scripts.find()) {
                    String body = scripts.group(1).strip();
                    boolean theme = body.contains("localStorage.getItem('zq.theme')") && !body.contains("\n");   // 第四十轮起是 zq.theme（原来 zq.ver）
                    // 原来还放过看板番茄钟那一段（真功能，不是示例）；第四十九轮番茄钟挪进了壳，这个口子收掉
                    if (!theme) {
                        found.add(name + " 有内联脚本：" + body.substring(0, Math.min(60, body.length())).replace('\n', ' '));
                    }
                }
                // <option> 是可选项（番茄钟的 25 / 45 / 60 分钟），不是谁的数据
                String markup = html.replaceAll("(?s)<script.*?</script>", " ").replaceAll("(?s)<!--.*?-->", " ")
                        .replaceAll("(?s)<option[^>]*>.*?</option>", " ");
                int mainAt = markup.indexOf("class=\"zq-main\"");
                assertTrue(mainAt >= 0, name + " 没有 .zq-main");
                Matcher text = Pattern.compile(">([^<>]*\\d[^<>]*)<").matcher(markup.substring(mainAt));
                while (text.find()) {
                    String t = text.group(1).strip();
                    if (!t.isEmpty() && !COPY_WITH_DIGITS.contains(t)) {
                        found.add(name + " 写死了「" + t + "」");
                    }
                }
                Matcher width = Pattern.compile("(?<![-\\w])width:\\s*([1-9]\\d*)%").matcher(markup.substring(mainAt));
                while (width.find()) {
                    found.add(name + " 写死了一个 " + width.group(1) + "% 的宽度（进度条？）");
                }
                // 输入框的 value 也算：个人资料的五个框原来写着设计稿的「王明远」「沪上理工大学」—— 第二十六轮才看到，上面那几道只看文字、
                // 不看属性。启动时会被真值盖掉所以没露出来，但它就是示例数据。数字 / 时间是表单默认值（例行计划的 45 分钟、08:00）。
                Matcher value = Pattern.compile("<(?:input|textarea)\\b[^>]*\\bvalue=\"([^\"]*)\"").matcher(markup.substring(mainAt));
                while (value.find()) {
                    if (!value.group(1).matches("[0-9:.\\-]*")) {
                        found.add(name + " 的输入框写死了 value=「" + value.group(1) + "」");
                    }
                }
            }
        }
        assertTrue(pages >= 12, "只扫到 " + pages + " 个页面 —— 空扫和干净的扫长得一样");
        assertEquals(List.of(), found, "页面里还有示例数据：启动成功时没被重绘的那部分会原样露给用户");
    }

    /**
     * 示例脚本顺带画出来的那几个真控件，现在写在页面里、由壳绑定。删示例时最容易一起删掉的就是它们 ——
     * 页面照样打开，只是统计页切不了日 / 周 / 月、成就页筛不了、例行计划选不了星期、参考计划的弹窗关不上，一个字都不报。
     */
    @Test
    void 示例脚本画的真控件写在页面里并且接上了() throws IOException {
        String stats = Files.readString(STATIC_DIR.resolve("statistics.html"), StandardCharsets.UTF_8);
        // 成就第三十轮成了弹窗（assets/settings.js 的 openAchievements），筛选按钮跟着过去
        String ach = SourceText.stripComments(Files.readString(STATIC_DIR.resolve("assets/settings.js"), StandardCharsets.UTF_8));
        for (String k : List.of("day", "week", "month")) {
            assertTrue(stats.contains("data-k=\"" + k + "\""), "统计页少了「" + k + "」按钮");
        }
        for (String k : List.of("all", "on", "off")) {
            assertTrue(ach.contains("filterBtn('" + k + "', "), "成就少了「" + k + "」筛选");
        }
        // 例行计划的星期按钮第五十六轮挪进了「新建 / 从任务生成」弹窗（pages/routines.js 的 settingsHtml）：七个、点了按下，在 routines-check.js 里真点
        // 参考计划的详情第五十七轮换成了 openModal（遮罩、×、Esc 都能关，SettingsDialogTest 管着）—— HTML 里那一套写死的弹窗删了
        String code = apiJs();
        // 统计页、例行计划页第三十二轮起是模块（pages/statistics.js、pages/routines.js）
        assertTrue(SourceText.pageModule("statistics.js").contains("$all('#zq-tabs button[data-k]').forEach(function (b) { b.onclick = function () { window.setTab(b.dataset.k); }; });"),
                "统计页的日 / 周 / 月没有接上");
        assertTrue(ach.contains("root.querySelectorAll('[data-ach-filters] button[data-k]').forEach(function (b) { b.onclick = function () { filter = b.dataset.k; renderAchList(filter); }; });"),
                "成就的筛选没有接上");
    }
}
