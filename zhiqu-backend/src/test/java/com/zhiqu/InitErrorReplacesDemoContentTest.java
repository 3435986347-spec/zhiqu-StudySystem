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
 * 页面里还躺着设计期的<b>示例数据</b>，而挡住它们的只有一处：加载失败时整块替换 {@code .zq-main}。
 *
 * <h2>这是什么局面</h2>
 *
 * <p>14 个页面里有 12 个内联了一段脚本，在应用脚本加载<b>之前</b>就把一批编造的学习数据
 * 写进 DOM —— 「2027 考研总目标」「王道 2027 版」「数学薄弱点清单」「番茄钟记录」之类。
 * {@code dashboard.html} 里作者自己标了 {@code // ── 示例数据（后续可由接口替换） ──}。
 *
 * <p>正常情况下用户看不到它们，靠三层：{@code zq-booting} 遮罩盖到 boot 完成；
 * boot 成功后重绘容器；boot <b>失败</b>时 {@link #INIT_ERROR} 把整个 {@code .zq-main}
 * 换成错误卡片。前两层在成功路径上，第三层是失败路径上唯一的一道 ——
 * 而 boot 失败并不罕见：本仓库对 {@code /api/**} 限流 180/60s，连续刷新就会 429。
 *
 * <h2>把它改成「只弹个提示」会怎样</h2>
 *
 * <p>页面接口一失败，用户就会看到一份完整的、不属于自己的学习计划：别人的考研目标、
 * 别人的薄弱点、别人的番茄钟记录，而且看起来像是自己的数据。没有任何报错说明那是假的。
 *
 * <p>所以这条判据钉的是<b>替换</b>这个动作本身，不是「有没有提示用户」。
 *
 * <h2>为什么不干脆删掉示例数据</h2>
 *
 * <p>那是更彻底的修法，但那些内联脚本里混着真实接线（{@code paintWd}、{@code zqPomoRecord}、
 * {@code openModal} 等被 HTML 的 {@code onclick} 直接引用），逐页拆分风险不小，
 * 而当前没有任何用户可见的问题。先把这道唯一的防线钉住，删除留作单独一件事。
 */
class InitErrorReplacesDemoContentTest {
    private static final Path STATIC_DIR = Path.of("src/main/resources/static");
    private static final Path API_JS = STATIC_DIR.resolve("assets/zhiqu-api.js");

    /** 含内联示例数据的页面数量下界 —— 低于它说明扫描坏了，而不是页面变干净了。 */
    private static final int MIN_DEMO_PAGES = 8;

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
        assertTrue(at >= 0, INIT_ERROR + " 不见了 —— 它是 12 个页面里的示例数据唯一的挡板");
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
        assertTrue(code.contains("if (boots[page]) await boots[page]();"),
                "页面 boot 的调度写法变了，本判据的锚点要跟着改");
        int at = code.indexOf("if (boots[page]) await boots[page]();");
        String after = code.substring(at, Math.min(code.length(), at + 900));
        assertTrue(after.contains("renderError: true"),
                "boot 必须在 renderError 模式下跑，否则失败时只弹个 toast，"
                        + "而遮罩照样被 finally 里的 revealContent 摘掉 —— 露出来的就是示例数据");
    }

    /**
     * 示例数据必须全部位于 {@code .zq-main} 之内。
     *
     * <p>这条是上面那条的前提：替换 {@code .zq-main} 之所以够用，正因为没有一处示例数据
     * 落在它外面。哪天有人把一块示例内容挪进侧边栏或页头，挡板就漏了 —— 而其它判据不会红。
     */
    @Test
    void 示例数据不得出现在主内容区之外() throws IOException {
        List<String> leaked = new ArrayList<>();
        int demoPages = 0;
        try (Stream<Path> pages = Files.list(STATIC_DIR)) {
            for (Path page : pages.filter(p -> p.toString().endsWith(".html")).sorted().toList()) {
                String html = Files.readString(page, StandardCharsets.UTF_8);
                // index.html 是落地页（轮播占位图），不含用户数据，renderInitError 也显式跳过它
                if ("index.html".equals(page.getFileName().toString())) {
                    continue;
                }
                List<String> targets = new ArrayList<>();
                Matcher scripts = INLINE_SCRIPT.matcher(html);
                while (scripts.find()) {
                    String body = scripts.group(1);
                    if (body.chars().filter(c -> c == '\n').count() <= 3) {
                        continue;   // 首个是主题初始化的一行式脚本
                    }
                    Matcher ids = Pattern.compile("getElementById\\('([^']+)'\\)").matcher(body);
                    while (ids.find()) {
                        targets.add(ids.group(1));
                    }
                }
                if (targets.isEmpty()) {
                    continue;
                }
                demoPages++;
                int mainAt = html.indexOf("zq-main");
                assertTrue(mainAt >= 0, page.getFileName() + " 没有 .zq-main 容器，挡板无处可依");
                for (String id : targets) {
                    int idAt = html.indexOf("id=\"" + id + "\"");
                    if (idAt < 0 || idAt < mainAt) {
                        leaked.add(page.getFileName() + "#" + id);
                    }
                }
            }
        }
        assertTrue(demoPages >= MIN_DEMO_PAGES,
                "只扫到 " + demoPages + " 个带内联示例数据的页面 —— 空扫和干净的扫形状一样，"
                        + "这个下界用来区分它们");
        assertEquals(List.of(), leaked,
                "这些示例数据写在 .zq-main 之外，加载失败时不会被替换掉，会直接呈现给用户");
    }
}
