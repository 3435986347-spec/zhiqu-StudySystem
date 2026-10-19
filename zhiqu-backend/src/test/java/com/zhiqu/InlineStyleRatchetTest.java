package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 界面打磨第 9 步的棘轮（第七十八轮起，docs/ui-plan.md）：内联样式、写死的字号只许降、不许升。
 *
 * <p>第 1 步时页面里有 817 处内联 {@code style=""}，值不共享，所以对不齐；第 3～8 步一页一页挪进样式表，第 8 步做完还剩 297 处。
 * 这条按<b>文件</b>钉住现在的数（用 {@code ==}，不是「不超过」）：多了一处是又写了内联样式 —— 写进 {@code zhiqu-ui.css} 的类；
 * 少了就把这里的数改小，下一次就不许再涨回去。字号同理：样式表、页面、脚本里写死的字号是一个固定的集合，多一种就红。
 *
 * <p>只有「按数据变的」才该留在内联里：柱子的 {@code --v}、资料卡片的类型色 {@code --srcc}、输入框按内容长高的 {@code style.height}。
 */
class InlineStyleRatchetTest {

    private static final Path STATIC = Path.of("src/main/resources/static");

    /**
     * 每个文件里的 {@code style=}（HTML 的属性、JS 拼的标记）。第七十八轮：AI 助手 121 → 1（资料卡片的 --srcc），Wiki 的定高包裹 1 处挪进 .zq-fill-page；
     * 第七十九轮：知识 Wiki 96 → 1（图谱图例的类型色 --c）。
     */
    private static final Map<String, Integer> STYLE_ATTRS = new TreeMap<>(Map.ofEntries(
            Map.entry("achievement.html", 1),
            Map.entry("dashboard.html", 30),
            Map.entry("profile.html", 1),
            Map.entry("tasks.html", 1),
            Map.entry("assets/pages/admin.js", 1),
            Map.entry("assets/pages/ai-assistant.js", 1),
            Map.entry("assets/pages/dashboard.js", 8),
            Map.entry("assets/pages/knowledge-wiki.js", 1),
            Map.entry("assets/pages/statistics.js", 1),
            Map.entry("assets/zhiqu-api.js", 28),
            Map.entry("assets/zhiqu-ui.js", 8)));

    /** 每个脚本里在 JS 里改样子的地方（{@code .style.x = …}、{@code .style[…]}、{@code cssText}）。AI 助手只剩输入框长高的 3 处；知识 Wiki 14 → 0（第七十九轮）。 */
    private static final Map<String, Integer> STYLE_WRITES = new TreeMap<>(Map.ofEntries(
            Map.entry("assets/pages/ai-assistant.js", 3),
            Map.entry("assets/pages/dashboard.js", 1),
            Map.entry("assets/zhiqu-api.js", 19),
            Map.entry("assets/zhiqu-ui.js", 11)));

    /** 写死的字号（不是 var(--zq-fs-*)）一共这几种。第七十八轮：AI 助手的 10 / 10.5 / 11 / 11.5 / 12.5 收进了令牌，但别的页还在用，所以种数没少。 */
    private static final Set<String> LITERAL_FONT_SIZES = new TreeSet<>(Set.of(
            ".92em", "10px", "10.5px", "11px", "11.5px", "12px", "12.5px", "13px", "13.5px", "14px", "14.5px",
            "15px", "15.5px", "16px", "17px", "19px", "20px", "24px", "30px", "38px"));

    private static final Pattern STYLE_ATTR = Pattern.compile("style=");
    private static final Pattern STYLE_WRITE = Pattern.compile("\\.style\\.|\\.style\\[|cssText");
    private static final Pattern FONT_SIZE = Pattern.compile("font-size:\\s*([0-9.]+(?:px|em|rem))|font:\\s*(?:[0-9]{3}\\s+)?([0-9.]+(?:px|em|rem))");

    /** 网页端自己写的文件：根目录下的页面 + assets 下的脚本（vendor 是第三方的，不算）。都去掉注释。 */
    private static Map<String, String> sources() throws IOException {
        Map<String, String> out = new TreeMap<>();
        try (Stream<Path> s = Files.list(STATIC)) {
            for (Path p : s.filter(p -> p.toString().endsWith(".html")).sorted().toList()) {
                out.put(p.getFileName().toString(), Files.readString(p, StandardCharsets.UTF_8).replaceAll("(?s)<!--.*?-->", " "));
            }
        }
        try (Stream<Path> s = Files.walk(STATIC.resolve("assets"))) {
            for (Path p : s.filter(p -> p.toString().endsWith(".js") && !p.toString().contains("/vendor/")).sorted().toList()) {
                out.put(STATIC.relativize(p).toString().replace('\\', '/'), SourceText.stripComments(Files.readString(p, StandardCharsets.UTF_8)));
            }
        }
        return out;
    }

    private static int count(Pattern p, String s) {
        Matcher m = p.matcher(s);
        int n = 0;
        while (m.find()) n++;
        return n;
    }

    @Test
    @DisplayName("内联样式按文件只许降：每个文件的 style= 和 JS 里改样子的地方和这里钉的一样多")
    void 内联样式只许降() throws IOException {
        Map<String, String> src = sources();
        assertTrue(src.size() >= 25, "只扫到 " + src.size() + " 个文件 —— 扫空了？");
        Map<String, Integer> attrs = new TreeMap<>(), writes = new TreeMap<>();
        for (Map.Entry<String, String> e : src.entrySet()) {
            int a = count(STYLE_ATTR, e.getValue()), w = count(STYLE_WRITE, e.getValue());
            if (a > 0) attrs.put(e.getKey(), a);
            if (w > 0) writes.put(e.getKey(), w);
        }
        assertEquals(STYLE_ATTRS, attrs, "内联 style= 的数变了：多了就是又写了内联样式（写进 zhiqu-ui.css 的类）；少了就把 STYLE_ATTRS 里的数改小");
        assertEquals(STYLE_WRITES, writes, "JS 里改样子的地方变了：按下 / 选中 / 悬停这类样子靠类和 aria-*，在样式表里画；少了就把 STYLE_WRITES 里的数改小");
        int total = attrs.values().stream().mapToInt(Integer::intValue).sum();
        // 界面打磨第 9 步的目标（docs/ui-plan.md）：817 处降到 100 以内。第七十九轮到了 81；上面按文件的 == 让它只能往下走
        assertTrue(total > 0 && total <= 100, "内联样式一共 " + total + " 处，第 9 步的目标是 100 以内");
    }

    @Test
    @DisplayName("写死的字号只许少：样式表、页面、脚本里不是 var(--zq-fs-*) 的字号是固定的那几种")
    void 写死的字号只许少() throws IOException {
        Map<String, String> src = new TreeMap<>(sources());
        src.put("assets/zhiqu-ui.css", SourceText.stripComments(Files.readString(STATIC.resolve("assets/zhiqu-ui.css"), StandardCharsets.UTF_8)));
        Set<String> found = new TreeSet<>();
        List<String> where = new ArrayList<>();
        for (Map.Entry<String, String> e : src.entrySet()) {
            Matcher m = FONT_SIZE.matcher(e.getValue());
            while (m.find()) {
                String v = m.group(1) != null ? m.group(1) : m.group(2);
                if (!LITERAL_FONT_SIZES.contains(v)) where.add(e.getKey() + "：" + v);
                found.add(v);
            }
        }
        assertTrue(found.size() >= 5, "只扫到 " + found.size() + " 种写死的字号 —— 扫空了？");
        assertEquals(List.of(), where, "多了一种写死的字号 —— 用 var(--zq-fs-2xs / xs / sm / base / md / lg / xl / 2xl)");
        assertEquals(LITERAL_FONT_SIZES, found, "有的字号已经没人用了：把它从 LITERAL_FONT_SIZES 里删掉，以后就不许再写");
    }
}
