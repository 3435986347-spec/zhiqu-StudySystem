package com.zhiqu;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 前端的两类「静默错误」：引用了不存在的 CSS 变量，以及用 UTC 当日历日期。
 *
 * <h2>它们的共同点：不报错、不崩，只是悄悄不对</h2>
 *
 * <p><b>一、{@code var(--x)} 而 {@code --x} 从未定义。</b>CSS 的处理方式是把整条属性判为无效、
 * 回落到初始值 —— {@code background} 变透明、{@code border-color} 变透明。没有任何警告。
 * 本仓库两处都中过：
 *
 * <ul>
 *   <li>{@code --zq-fontM} 从未定义，而 Wiki 源码编辑器写的是 {@code var(--zq-fontM, monospace)}，
 *       于是回落到裸 {@code monospace}，中文由系统随便挑字体 —— 「源码模式字体很怪」。</li>
 *   <li>CSS 定义的是 {@code --zq-q1bg} / {@code --zq-q1bd}（中间没有连字符），而<b>所有</b>消费方
 *       写的都是 {@code --zq-q1-bg} / {@code --zq-q1-border}。两边从来没对上，于是四象限的
 *       底色胶囊一直是透明的（实测 {@code rgba(0,0,0,0)}），只有文字颜色是对的。
 *       四象限是这个产品的招牌视觉。</li>
 * </ul>
 *
 * <p><b>二、{@code new Date().toISOString().slice(0,10)} 当日历日期。</b>那是 UTC。
 * 东八区凌晨 0 点到 8 点之间它给出昨天，而后端业务日期是 Asia/Shanghai。后果不止显示：
 * 例行打卡的 {@code checkDate} 记成昨天（连续天数因此断掉）、番茄钟的学习时长记到昨天、
 * 新建例行与套用共享计划的开始日期都是昨天。
 */
class FrontendTokenAndDateTest {
    private static final Path STATIC_DIR = Path.of("src/main/resources/static");
    private static final Path CSS = STATIC_DIR.resolve("assets/zhiqu-ui.css");

    /** 令牌定义数量的下界 —— 低于它说明解析坏了，不是 CSS 变干净了。 */
    private static final int MIN_DEFINED_TOKENS = 30;

    private static Set<String> definedTokens() throws IOException {
        String css = Files.readString(CSS, StandardCharsets.UTF_8);
        Set<String> defined = new LinkedHashSet<>();
        Matcher m = Pattern.compile("(--zq-[\\w-]+)\\s*:").matcher(css);
        while (m.find()) {
            defined.add(m.group(1));
        }
        return defined;
    }

    /** 所有会被浏览器执行/渲染的前端文件。 */
    private static List<Path> frontendFiles() throws IOException {
        List<Path> files = new ArrayList<>();
        try (Stream<Path> all = Files.walk(STATIC_DIR)) {
            for (Path f : all.sorted().toList()) {
                String name = f.toString();
                // js/*.js 与 css/*.css 都是<b>零页面加载</b>的遗留目录 —— 现行的 14 个页面只加载
                // assets/zhiqu-ui.{js,css} 与 assets/zhiqu-api.js。写在那两个目录里的东西
                // 用户碰不到，所以也不该因为它们而让构建红。
                // （CLAUDE.md 原来只写了 js/*.js，css/ 是本判据第一次跑时扫出来的。）
                if (name.contains("/js/") || name.contains("/css/")) {
                    continue;
                }
                // assets/vendor/ 是原样引入的第三方（katex 等）。它里面写死的字体栈不归我们改，
                // 拿「我们的代码必须如何」的判据去扫它只会得到永远修不掉的红。
                if (name.contains("/vendor/")) {
                    continue;
                }
                if (name.endsWith(".html") || name.endsWith(".js") || name.endsWith(".css")) {
                    files.add(f);
                }
            }
        }
        return files;
    }

    /**
     * 引用到的每个 {@code --zq-*} 都必须有定义。
     *
     * <p>扰动：把任意一个定义改名 → 本条红，并点名是哪个变量、在哪个文件。
     */
    @Test
    void 引用的CSS变量必须都有定义() throws IOException {
        Set<String> defined = definedTokens();
        assertTrue(defined.size() >= MIN_DEFINED_TOKENS,
                "只解析出 " + defined.size() + " 个令牌定义 —— 空扫和干净的扫形状一样");

        List<String> dangling = new ArrayList<>();
        int checked = 0;
        for (Path file : frontendFiles()) {
            String src = Files.readString(file, StandardCharsets.UTF_8);
            Matcher m = Pattern.compile("var\\(\\s*(--zq-[\\w-]+)").matcher(src);
            while (m.find()) {
                checked++;
                String name = m.group(1);
                // 动态拼出来的名字（'var(--zq-' + q + '-bg)'）在这里只能看到字面量前缀，
                // 拿它去比对必然误报。那一半由「四象限的色令牌必须成套」专门覆盖 ——
                // 而恰恰是那一半坏了最久。
                String rest = src.substring(m.end(), Math.min(src.length(), m.end() + 4));
                if (rest.startsWith("'") || rest.startsWith("\"")) {
                    continue;
                }
                if (!defined.contains(name)) {
                    int line = (int) src.substring(0, m.start()).chars().filter(c -> c == '\n').count() + 1;
                    dangling.add(STATIC_DIR.relativize(file) + ":" + line + " " + name);
                }
            }
        }
        assertTrue(checked > 100, "只扫到 " + checked + " 处 var() 引用 —— 扫描多半坏了");
        assertEquals(List.of(), dangling,
                "这些 var() 引用的变量没有定义。CSS 会把整条属性判为无效并回落到初始值 —— "
                        + "背景变透明、边框变透明、字体变成系统默认，而且没有任何报错");
    }

    /**
     * 四象限的三个色令牌必须成套 —— 这一条是上面那条的具体化。
     *
     * <p>象限色有一半是<b>动态拼出来</b>的（{@code 'var(--zq-' + q + '-bg)'}），上面那条的正则
     * 看不见它们。而恰恰是这一半坏了最久。
     */
    @Test
    void 四象限的色令牌必须成套() throws IOException {
        Set<String> defined = definedTokens();
        List<String> missing = new ArrayList<>();
        for (int q = 1; q <= 4; q++) {
            for (String suffix : new String[]{"", "-bg", "-border"}) {
                String name = "--zq-q" + q + suffix;
                if (!defined.contains(name)) {
                    missing.add(name);
                }
            }
        }
        assertEquals(List.of(), missing,
                "四象限的色令牌不成套。前端有一半是动态拼名字的（var('--zq-' + q + '-bg')），"
                        + "少一个不会报错，只会让那一格的底色悄悄变透明");
    }

    /**
     * 日历日期不得用 UTC 算。
     *
     * <p>扰动：把 {@code today()} 改回 {@code toISOString().slice(0,10)} → 本条红。
     */
    @Test
    void 日历日期不得用UTC() throws IOException {
        List<String> offenders = new ArrayList<>();
        for (Path file : frontendFiles()) {
            String src = SourceText.stripComments(Files.readString(file, StandardCharsets.UTF_8))
                    .replaceAll("(?s)<!--.*?-->", " ");
            Matcher m = Pattern.compile("toISOString\\(\\)\\s*\\.\\s*slice\\(\\s*0\\s*,\\s*10\\s*\\)").matcher(src);
            while (m.find()) {
                int line = (int) src.substring(0, m.start()).chars().filter(c -> c == '\n').count() + 1;
                offenders.add(STATIC_DIR.relativize(file) + ":" + line);
            }
        }
        assertEquals(List.of(), offenders,
                "这些地方用 toISOString().slice(0,10) 当日历日期 —— 那是 UTC。"
                        + "东八区凌晨 0-8 点之间它给出昨天：打卡记成昨天、连续天数断掉、"
                        + "番茄钟的学习时长记到昨天。用 localDate() 取本地日期");
    }

    /** 唯一的日期实现必须暴露出去，页面内联脚本才不会各写一份。 */
    @Test
    void 日期实现必须被内联脚本共用() throws IOException {
        String api = SourceText.stripComments(
                Files.readString(STATIC_DIR.resolve("assets/zhiqu-api.js"), StandardCharsets.UTF_8));
        assertTrue(api.contains("window.zqApi = { api: api, reload: route, today: today, localDate: localDate };"),
                "localDate/today 必须挂在 window.zqApi 上 —— dashboard 的番茄钟等内联脚本要算「今天」，"
                        + "不暴露的话它们只能各写一个 toISOString，而那正是刚修掉的那个 bug");
    }

    /**
     * 等宽字体栈只允许出现在 {@code --zq-fontM} 的那一处定义里。
     *
     * <p>这一条钉的是<b>同一事实的多份拷贝</b>，而不是某一个具体的坏显示。
     * 2026-09-21 修「Wiki 源码模式字体很怪」时，同一个字体栈在活文件里有三份：
     *
     * <ul>
     *   <li>{@code .zq-mono} —— 仓库当时真正的等宽约定</li>
     *   <li>{@code routines.html} 的内联样式</li>
     *   <li>{@code .zq-artifact-json} —— 这一处是收尾时才扫出来的，前两处都修完了它还在</li>
     * </ul>
     *
     * <p>三份都只有拉丁字形、没有中文字形，于是中文一律回落到系统默认字体，与页面正文
     * （{@code Noto Serif SC}）两样。改一份不改另外两份，症状就只消失一部分 —— 这正是
     * 「源码模式字体很怪」拖了那么久的原因：每次都像修好了。
     *
     * <p>现在唯一的定义在 {@code --zq-fontM}，它在等宽字体后面接了中文衬线字体。
     * 字体回退是<b>逐字符</b>的，所以拉丁字母仍是等宽（Markdown 该对齐的地方照样对齐），
     * 中文则落到与正文同一族。
     *
     * <p>扰动：把 {@code .zq-artifact-json} 的 {@code var(--zq-fontM)} 改回写死的字体栈 → 本条红。
     */
    @Test
    void 等宽字体栈只许定义一次() throws IOException {
        List<String> hardcoded = new ArrayList<>();
        int scanned = 0;
        for (Path file : frontendFiles()) {
            scanned++;
            String src = SourceText.stripComments(Files.readString(file, StandardCharsets.UTF_8))
                    .replaceAll("(?s)<!--.*?-->", " ");
            Matcher m = Pattern.compile("JetBrains Mono|Consolas|monospace").matcher(src);
            while (m.find()) {
                // 唯一允许的那一处：--zq-fontM 自己的定义。
                int lineStart = src.lastIndexOf('\n', m.start()) + 1;
                if (src.startsWith("  --zq-fontM:", lineStart) || src.regionMatches(lineStart, "--zq-fontM:", 0, 11)) {
                    continue;
                }
                int line = (int) src.substring(0, m.start()).chars().filter(c -> c == '\n').count() + 1;
                hardcoded.add(STATIC_DIR.relativize(file) + ":" + line + " " + m.group());
            }
        }
        // 下限：扫空和扫干净长得一样。14 个页面 + assets 至少这么多个文件。
        assertTrue(scanned >= 14, "只扫了 " + scanned + " 个前端文件 —— 枚举多半坏了");

        assertEquals(List.of(), hardcoded,
                "等宽字体栈只允许在 --zq-fontM 里定义一次，这些地方又写死了一份。"
                        + "写死的那几份都没有中文字形，中文会回落到系统默认字体，与页面正文不一致；"
                        + "而且改一处不改其余处，症状只会消失一部分 —— 用 var(--zq-fontM)");
    }

    /**
     * {@code hidden} 属性必须真的能藏住东西。
     *
     * <h2>为什么这需要一条 CSS 规则来兜底</h2>
     *
     * <p>{@code hidden} 本身只是 UA 样式表里的 {@code [hidden]{display:none}}，优先级 (0,1,0)。
     * 作者样式表里<b>任何一个设了 display 的类选择器</b>都能压过它 —— 本仓库的
     * {@code .zq-btn-ghost{display:inline-flex}} 就是其中之一。于是
     * {@code <button class="zq-btn-ghost" hidden>} 完全可见，而 JS 里读 {@code el.hidden}
     * 得到 {@code true}：代码、日志、断点全都说藏起来了，只有屏幕上还显示着。
     *
     * <p>2026-09-21 实地撞到两次，一次是内联样式压掉（提醒渠道的三个分组），
     * 一次是类选择器压掉（代码工作区的「上一层」「返回目录」两个按钮，
     * 浏览器里实测 {@code hidden=true} 而 {@code getComputedStyle().display='flex'}）。
     * <b>两次都是截图发现的，代码审查一次都没发现。</b>
     *
     * <p>根治办法是在 {@code zhiqu-ui.css} 里写一条
     * {@code [hidden]{display:none !important}}。它一旦被删掉，全站每个带 {@code hidden}
     * 的 {@code .zq-btn-ghost} / {@code .zq-ai-attachments} 会一起复发，而且没有任何报错 ——
     * 所以这条规则的存在本身就是判据要钉的东西。
     *
     * <p>扰动：删掉那条 CSS 规则 → 本条红；
     * 给任意 {@code hidden} 元素加上 {@code style="display:flex !important"} → 本条也红。
     */
    @Test
    void hidden必须真的能藏住() throws IOException {
        String css = Files.readString(CSS, StandardCharsets.UTF_8);

        // 一、兜底规则必须在。这是全站所有 hidden 用法的地基。
        assertTrue(Pattern.compile("\\[hidden\\]\\s*\\{[^}]*display\\s*:\\s*none\\s*!important")
                        .matcher(css).find(),
                "zhiqu-ui.css 里必须有 [hidden]{display:none !important}。没有它，"
                        + "任何设了 display 的类（.zq-btn-ghost 就是）都会让 hidden 失效 —— "
                        + "元素在屏幕上，而 JS 读 el.hidden 是 true，查起来极难");

        // 二、唯一还能打赢 !important 的，是同样带 !important 的内联 display。
        List<String> defeats = new ArrayList<>();
        int tagsScanned = 0;
        for (Path file : frontendFiles()) {
            if (!file.toString().endsWith(".html")) {
                continue;
            }
            String src = Files.readString(file, StandardCharsets.UTF_8).replaceAll("(?s)<!--.*?-->", " ");
            Matcher tag = Pattern.compile("<[a-zA-Z][^>]*>").matcher(src);
            while (tag.find()) {
                tagsScanned++;
                String open = tag.group();
                if (!Pattern.compile("[\\s\"']hidden[\\s>=]").matcher(open).find()) {
                    continue;
                }
                Matcher style = Pattern.compile("style\\s*=\\s*\"([^\"]*)\"").matcher(open);
                if (style.find() && Pattern.compile("display\\s*:[^;]*!important").matcher(style.group(1)).find()) {
                    int line = (int) src.substring(0, tag.start()).chars().filter(c -> c == '\n').count() + 1;
                    defeats.add(STATIC_DIR.relativize(file) + ":" + line);
                }
            }
        }
        // 下限：扫空和扫干净长得一样。
        assertTrue(tagsScanned > 300, "只扫到 " + tagsScanned + " 个标签 —— 解析多半坏了");

        assertEquals(List.of(), defeats,
                "这些 hidden 元素的内联 display 带了 !important，会打赢兜底规则 —— "
                        + "结果又是「JS 说藏了、屏幕上还在」。内联样式里不要给 display 加 !important");
    }
}
