package com.zhiqu;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 钉住图标与 PWA 清单<b>真的被页面引用了</b>。
 *
 * <p>2026-09-21 之前的状态：{@code manifest.json} 存在、内容看着也对，但
 * {@code "icons": []} 是空的，而且 <b>14 个页面里 0 个引用它</b>。
 * 一个没有任何人引用的清单不会报错、不会有任何症状 —— 它只是不起作用：
 * 「添加到主屏幕」拿不到图标，浏览器标签页也没有。
 *
 * <p>这一类缺陷单看文件是发现不了的（文件本身完全正常），只能从「有没有人用它」这一侧查。
 */
class WebAppManifestTest {

    private static final Path STATIC = Path.of("src", "main", "resources", "static");

    private static List<Path> pages() throws IOException {
        try (var list = Files.list(STATIC)) {
            return list.filter(p -> p.toString().endsWith(".html")).sorted().toList();
        }
    }

    @Test
    @DisplayName("每个页面都要引用 manifest、favicon 与 apple-touch-icon")
    void 每个页面都要引用图标与清单() throws IOException {
        List<Path> pages = pages();
        assertTrue(pages.size() >= 14, "只扫到 " + pages.size() + " 个页面 —— 扫空或扫漏了");

        List<String> missing = new ArrayList<>();
        for (Path page : pages) {
            String html = Files.readString(page, StandardCharsets.UTF_8);
            List<String> gaps = new ArrayList<>();
            if (!html.contains("rel=\"manifest\"")) gaps.add("manifest");
            if (!html.contains("rel=\"icon\"")) gaps.add("favicon");
            if (!html.contains("rel=\"apple-touch-icon\"")) gaps.add("apple-touch-icon");
            if (!gaps.isEmpty()) missing.add(page.getFileName() + gaps.toString());
        }
        assertTrue(missing.isEmpty(),
                "这些页面没有引用图标 / 清单：" + missing
                        + "。文件存在不等于生效 —— 这正是 0/14 那次的样子。");
    }

    @Test
    @DisplayName("manifest 的 icons 不能是空数组，且每个文件都要真的存在")
    void 清单里的图标必须存在() throws IOException {
        JsonNode manifest = new ObjectMapper()
                .readTree(Files.readString(STATIC.resolve("manifest.json"), StandardCharsets.UTF_8));
        JsonNode icons = manifest.get("icons");
        assertTrue(icons != null && icons.isArray() && !icons.isEmpty(),
                "manifest.json 的 icons 是空的。空数组不会报错，只是「添加到主屏幕」没有图标。");

        List<String> broken = new ArrayList<>();
        for (JsonNode icon : icons) {
            String src = icon.path("src").asText("");
            if (src.isBlank() || !Files.isRegularFile(STATIC.resolve(src))) {
                broken.add(src.isBlank() ? "(空 src)" : src);
            }
        }
        assertTrue(broken.isEmpty(), "manifest 里这些图标文件不存在：" + broken);

        // maskable 单独要有一张：Android 会把图标裁成圆形，没有 maskable 版本时
        // 系统会自己加白底，方形图标四角会露出来。
        boolean hasMaskable = false;
        for (JsonNode icon : icons) {
            if (icon.path("purpose").asText("").contains("maskable")) {
                hasMaskable = true;
            }
        }
        assertTrue(hasMaskable, "缺少 purpose=maskable 的图标，Android 上会被加白底后裁角");
    }

    @Test
    @DisplayName("浏览器边框的颜色和界面的底色一致：manifest、各页浅 / 深两个 theme-color")
    void 主题色不能和界面分叉() throws IOException {
        // 第四十轮起是中性配色：状态栏、标签栏跟着页面底色走（浅色 #FAFAFA、深色近黑），不再用强调色 ——
        // 原来这里比的是 --zq-primary（那时状态栏用的是主题蓝）。分叉的表现照旧：装成 PWA 之后状态栏和应用里的颜色对不上。
        JsonNode manifest = new ObjectMapper()
                .readTree(Files.readString(STATIC.resolve("manifest.json"), StandardCharsets.UTF_8));
        String themeColor = manifest.path("theme_color").asText("").toUpperCase();
        String background = manifest.path("background_color").asText("").toUpperCase();
        assertFalse(themeColor.isBlank(), "manifest 没有 theme_color");

        String css = SourceText.stripComments(Files.readString(STATIC.resolve("assets/zhiqu-ui.css"), StandardCharsets.UTF_8));
        String lightBg = token(css, ":root", "--zq-bg");
        String darkBg = token(css, "html[data-zq-mode=\"dark\"]", "--zq-bg");
        assertTrue(themeColor.equals(lightBg), "manifest 的 theme_color(" + themeColor + ") 和浅色的底色 --zq-bg(" + lightBg + ") 不一致");
        assertTrue(background.equals(lightBg), "manifest 的 background_color(" + background + ") 和浅色的底色 --zq-bg(" + lightBg + ") 不一致 —— 启动画面会是另一种颜色");

        List<String> drift = new ArrayList<>();
        int pages = 0;
        try (java.util.stream.Stream<Path> list = Files.list(STATIC)) {
            for (Path page : list.filter(f -> f.toString().endsWith(".html")).sorted().toList()) {
                pages++;
                String html = Files.readString(page, StandardCharsets.UTF_8);
                String light = meta(html, "light"), dark = meta(html, "dark");
                if (!lightBg.equals(light) || !darkBg.equals(dark)) drift.add(page.getFileName() + "：浅 " + light + "、深 " + dark);
            }
        }
        assertTrue(pages >= 14, "只扫到 " + pages + " 个页面");
        assertTrue(drift.isEmpty(), "这些页面的 theme-color 和底色（浅 " + lightBg + "、深 " + darkBg + "）对不上：" + drift);
    }

    private static String token(String css, String selector, String name) {
        java.util.regex.Matcher block = java.util.regex.Pattern.compile("(?m)^" + java.util.regex.Pattern.quote(selector) + "\\{([^}]*)\\}").matcher(css);
        assertTrue(block.find(), "找不到 " + selector + " 那一块");
        java.util.regex.Matcher v = java.util.regex.Pattern.compile(java.util.regex.Pattern.quote(name) + "\\s*:\\s*([^;]+);").matcher(block.group(1));
        assertTrue(v.find(), selector + " 里没有 " + name);
        return v.group(1).trim().toUpperCase();
    }

    private static String meta(String html, String scheme) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("<meta name=\"theme-color\" content=\"(#[0-9A-Fa-f]{6})\" media=\"\\(prefers-color-scheme: " + scheme + "\\)\">").matcher(html);
        return m.find() ? m.group(1).toUpperCase() : "（没有）";
    }
}
