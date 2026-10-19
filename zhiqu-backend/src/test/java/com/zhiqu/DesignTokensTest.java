package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 界面打磨第 1 步（第四十轮，docs/ui-plan.md）：设计令牌。用户 2026-10-06 定的：中性风；白天白色、晚上黑色（跟着系统外观走）；
 * 强调色金色，也做一版黑白 —— 第四十一轮用户看过截图定了「主题就黑白的吧」：默认黑白，金色可选。原来是五套配色 × 明暗共 10 套、次要文字对比度约 2.7 : 1、字重有 650 / 700 / 800。
 */
class DesignTokensTest {

    private static final Path STATIC = Path.of("src/main/resources/static");
    private static final Path CSS = STATIC.resolve("assets/zhiqu-ui.css");
    private static final String ROOT = ":root";
    private static final String DARK = "html[data-zq-mode=\"dark\"]";
    private static final String GOLD = "html[data-zq-accent=\"gold\"]";
    private static final String DARK_GOLD = "html[data-zq-mode=\"dark\"][data-zq-accent=\"gold\"]";
    /** 不随明暗变的令牌：字阶、间距、字重、圆角、字体 */
    private static final Pattern MODE_FREE = Pattern.compile("--zq-(fs-|sp-|fw-|r[sml]$|font)");

    private static String css() throws IOException {
        return SourceText.stripComments(Files.readString(CSS, StandardCharsets.UTF_8));
    }

    /** 选择器正好是 selector 的那一块里的 --zq-* 定义（按出现顺序） */
    private static Map<String, String> block(String css, String selector) {
        Matcher m = Pattern.compile("(?m)^" + Pattern.quote(selector) + "\\{([^}]*)\\}").matcher(css);
        assertTrue(m.find(), "找不到 " + selector + " 那一块");
        Map<String, String> out = new LinkedHashMap<>();
        Matcher d = Pattern.compile("(--zq-[\\w-]+)\\s*:\\s*([^;]+);").matcher(m.group(1));
        while (d.find()) out.put(d.group(1), d.group(2).trim());
        assertTrue(!m.find(), selector + " 那一块出现了不止一次");
        return out;
    }

    private static List<Path> pages() throws IOException {
        try (Stream<Path> list = Files.list(STATIC)) {
            return list.filter(p -> p.toString().endsWith(".html")).sorted().collect(Collectors.toList());
        }
    }

    @Test
    @DisplayName("外观跟着系统走、固定了不跟、原来的键不再读、强调色默认金色（在 node 里真跑头上那行和 zhiqu-ui.js）")
    void 外观() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/theme-check.js"), STATIC.resolve("assets/zhiqu-ui.js"),
                STATIC.resolve("dashboard.html").toAbsolutePath().toString()), "theme-check.js 没有全绿");
    }

    @Test
    @DisplayName("每一页头上是同一行外观脚本；任何地方都不再有 data-zq-ver（五套配色那一套）")
    void 只有一套配色() throws IOException {
        Pattern head = Pattern.compile("<script>(\\(function\\(\\)\\{try\\{var h=document\\.documentElement[^<]*)</script>");
        Set<String> scripts = new TreeSet<>();
        List<String> missing = new ArrayList<>();
        List<Path> pages = pages();
        assertTrue(pages.size() >= 14, "只扫到 " + pages.size() + " 个页面");
        for (Path p : pages) {
            String html = Files.readString(p, StandardCharsets.UTF_8);
            Matcher m = head.matcher(html);
            if (m.find()) scripts.add(m.group(1));
            else missing.add(p.getFileName().toString());
        }
        assertEquals(List.of(), missing, "这些页面头上没有那行外观脚本 —— 打开时会先闪一下另一种颜色");
        assertEquals(1, scripts.size(), "各页头上的外观脚本不一样（只验了一页，别的页会各走各的）：" + scripts);

        List<String> stale = new ArrayList<>();
        List<Path> all = new ArrayList<>(pages);
        try (Stream<Path> walk = Files.walk(STATIC.resolve("assets"))) {
            walk.filter(p -> p.toString().endsWith(".js") || p.toString().endsWith(".css")).filter(p -> !p.toString().contains("/vendor/")).forEach(all::add);
        }
        for (Path f : all) {
            String code = f.toString().endsWith(".html") ? Files.readString(f, StandardCharsets.UTF_8)
                    : SourceText.stripComments(Files.readString(f, StandardCharsets.UTF_8));
            if (code.contains("data-zq-ver") || code.contains("'zq.ver'") || code.contains("'zq.mode'")) stale.add(STATIC.relativize(f).toString());
        }
        assertEquals(List.of(), stale, "这些文件还在用五套配色那一套（data-zq-ver / zq.ver / zq.mode）");

        String css = css();
        Map<String, String> root = block(css, ROOT), dark = block(css, DARK), gold = block(css, GOLD), darkGold = block(css, DARK_GOLD);
        Set<String> modeTokens = root.keySet().stream().filter(k -> !MODE_FREE.matcher(k).find()).collect(Collectors.toCollection(TreeSet::new));
        assertTrue(modeTokens.size() >= 40, "浅色只扫到 " + modeTokens.size() + " 个颜色令牌");
        assertEquals(modeTokens, new TreeSet<>(dark.keySet()), "深色和浅色定义的颜色令牌不是同一批 —— 少定义的那个在深色里会是浅色的值");
        assertEquals(new TreeSet<>(gold.keySet()), new TreeSet<>(darkGold.keySet()), "金色强调的浅 / 深两块定义的令牌不一样");
        assertTrue(gold.keySet().containsAll(List.of("--zq-primary", "--zq-primary-dark", "--zq-on-primary", "--zq-tint", "--zq-tint-strong", "--zq-accent", "--zq-focus")),
                "金色强调少了几个强调色令牌：" + gold.keySet());
    }

    @Test
    @DisplayName("对比度（按样式表里的值算）：浅 / 深 × 金 / 黑白，各级文字在各种底上 ≥ 4.5 : 1，强调色作文字、按钮上的字也是")
    void 对比度() throws IOException {
        String css = css();
        Map<String, String> root = block(css, ROOT), dark = block(css, DARK), gold = block(css, GOLD), darkGold = block(css, DARK_GOLD);
        Map<String, Map<String, String>> themes = new LinkedHashMap<>();
        themes.put("浅色·黑白", merge(root));
        themes.put("浅色·金", merge(root, gold));
        themes.put("深色·黑白", merge(root, dark));
        themes.put("深色·金", merge(root, dark, gold, darkGold));
        List<String[]> pairs = new ArrayList<>();
        for (String fg : List.of("--zq-text", "--zq-text2", "--zq-text3"))
            for (String bg : List.of("--zq-bg", "--zq-card", "--zq-card-soft")) pairs.add(new String[]{fg, bg});
        pairs.add(new String[]{"--zq-sb-text", "--zq-sb-bg"});
        pairs.add(new String[]{"--zq-sb-active-text", "--zq-sb-bg"});
        pairs.add(new String[]{"--zq-on-primary", "--zq-primary"});
        // 迷你番茄钟的胶囊（第五十轮）：不跟着明暗变；胶囊是 86% 的不透明度，铺在白底上最浅也只到 #3C3C3E，次要文字在那上面约 5.3 : 1
        pairs.add(new String[]{"--zq-mini-text", "--zq-mini-bg"});
        pairs.add(new String[]{"--zq-mini-text2", "--zq-mini-bg"});
        pairs.add(new String[]{"--zq-primary", "--zq-card"});
        pairs.add(new String[]{"--zq-primary", "--zq-bg"});
        for (String c : List.of("--zq-ok", "--zq-warn", "--zq-bad", "--zq-q1", "--zq-q2", "--zq-q3", "--zq-q4")) pairs.add(new String[]{c, "--zq-card"});
        List<String> low = new ArrayList<>();
        int checked = 0;
        for (Map.Entry<String, Map<String, String>> t : themes.entrySet()) {
            for (String[] p : pairs) {
                double ratio = contrast(hex(t.getValue(), p[0]), hex(t.getValue(), p[1]));
                checked++;
                if (ratio < 4.5) low.add(String.format("%s：%s 在 %s 上 %.2f : 1", t.getKey(), p[0], p[1], ratio));
            }
        }
        assertTrue(checked >= 80, "只算了 " + checked + " 对");
        assertEquals(List.of(), low, "对比度不够（WCAG AA 要 4.5 : 1）");
    }

    @Test
    @DisplayName("组件类的字重只有 400 / 500 / 600（原来有 650、700、800）")
    void 字重() throws IOException {
        String css = css();
        Set<String> weights = new TreeSet<>();
        Matcher m = Pattern.compile("font-weight\\s*:\\s*(\\d+)|font\\s*:\\s*(\\d{3})\\b").matcher(css);
        while (m.find()) weights.add(m.group(1) != null ? m.group(1) : m.group(2));
        Matcher v = Pattern.compile("--zq-fw-[\\w-]+\\s*:\\s*(\\d+)").matcher(css);
        while (v.find()) weights.add(v.group(1));
        assertTrue(weights.containsAll(Set.of("500", "600")), "字重扫空了？" + weights);
        weights.removeAll(Set.of("400", "500", "600"));
        assertEquals(Set.of(), weights, "样式表里又出现了字阶以外的字重");
    }

    @Test
    @DisplayName("字细一点但看得清（第四十一轮，用户要「像 claude 里面的一样」）：半粗只给品牌标志和正文里的加粗；主按钮、选中的导航用中等")
    void 字更细() throws IOException {
        String css = css();
        Set<String> semibold = new TreeSet<>(), medium = new TreeSet<>();
        Matcher rule = Pattern.compile("([^{}]+)\\{([^{}]*)\\}").matcher(css);
        while (rule.find()) {
            String selector = rule.group(1).trim(), body = rule.group(2);
            if (body.contains("--zq-fw-semibold:")) continue;   // 令牌自己的定义
            if (body.contains("var(--zq-fw-semibold)")) semibold.add(selector);
            if (body.contains("var(--zq-fw-medium)")) medium.add(selector);
        }
        assertEquals(new TreeSet<>(Set.of("b,strong", ".zq-brand-badge")), semibold,
                "半粗（600）又用到了别处 —— 用户要的是像 Claude 那样细一点的字；标题、按钮用中等（500），其余用常规（400）");
        assertTrue(medium.containsAll(Set.of(".zq-btn", ".zq-nav a.active", ".zq-h1", ".zq-h2")), "主按钮、选中的导航、标题应当是中等字重：" + medium);
        // 行首：「.zq-side.is-collapsed .zq-nav a{…}」里也有「.zq-nav a{」，而且排在前面
        Matcher nav = Pattern.compile("(?m)^\\.zq-nav a\\{([^}]*)\\}").matcher(css);
        assertTrue(nav.find() && nav.group(1).contains("var(--zq-fw-regular)"), "导航项应当是常规字重");
        Matcher label = Pattern.compile("(?m)^\\.zq-label\\{([^}]*)\\}").matcher(css);
        assertTrue(label.find() && label.group(1).contains("var(--zq-fw-regular)"), "表单标签应当是常规字重");
    }

    @Test
    @DisplayName("页面、模块、壳里的内联样式不写死字重，只用 --zq-fw-*（原来 95 处 600 / 700，字重一调就漏一大片）")
    void 内联字重只用令牌() throws IOException {
        List<Path> files = new ArrayList<>(pages());
        try (Stream<Path> walk = Files.walk(STATIC.resolve("assets"))) {
            walk.filter(p -> p.toString().endsWith(".js")).filter(p -> !p.toString().contains("/vendor/")).forEach(files::add);
        }
        assertTrue(files.size() >= 25, "只扫到 " + files.size() + " 个文件");
        List<String> hard = new ArrayList<>();
        int tokens = 0;
        // 拼出来的也算（第六十九轮：Wiki 目录项 'font-weight:' + (active ? 700 : 500) 一直没被扫到 —— 选中的那一项是 700）
        Pattern raw = Pattern.compile("font-weight\\s*:\\s*(\\d{3}|bold|bolder|lighter)\\b|font\\s*:\\s*\\d{3}\\b|font-weight\\s*:\\s*['\"]\\s*\\+[^;]{0,80}?\\b[1-9]00\\b");
        for (Path f : files) {
            String code = Files.readString(f, StandardCharsets.UTF_8);
            Matcher m = raw.matcher(code);
            while (m.find()) hard.add(STATIC.relativize(f) + "：" + m.group());
            Matcher t = Pattern.compile("font-weight:\\s*var\\(--zq-fw-").matcher(code);
            while (t.find()) tokens++;
        }
        // 下限跟着内联样式挪进样式表往下走：第五十五轮 renderMarkdown、知识 Wiki 的头挪走一批（80 → 75 处），第五十六轮例行计划页又一批（→ 65），第五十七轮参考计划、专注统计（→ 54），
        // 第七十五轮设置、成就弹窗（→ 41）。第 9 步把内联样式降下来之后，这条换成棘轮（只许降、不许升），见 docs/ui-plan.md
        assertTrue(tokens >= 35, "内联字重只扫到 " + tokens + " 处用令牌 —— 扫空了？");
        assertEquals(List.of(), hard, "这些地方又写死了字重 —— 用 var(--zq-fw-regular / medium / semibold)");
    }

    @SafeVarargs
    private static Map<String, String> merge(Map<String, String>... layers) {
        Map<String, String> out = new LinkedHashMap<>();
        for (Map<String, String> l : layers) out.putAll(l);
        return out;
    }

    private static int[] hex(Map<String, String> theme, String token) {
        String v = theme.get(token);
        assertTrue(v != null, "没有定义 " + token);
        Matcher m = Pattern.compile("^#([0-9A-Fa-f]{6})$").matcher(v);
        assertTrue(m.find(), token + " 不是 #RRGGBB（" + v + "）—— 算不了对比度");
        int rgb = Integer.parseInt(m.group(1), 16);
        return new int[]{(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255};
    }

    private static double luminance(int[] c) {
        double[] l = new double[3];
        for (int i = 0; i < 3; i++) {
            double s = c[i] / 255.0;
            l[i] = s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        }
        return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
    }

    static double contrast(int[] a, int[] b) {
        double la = luminance(a), lb = luminance(b);
        return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    }
}
