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
    @DisplayName("manifest 的主题色要和基础主题的 --zq-primary 一致")
    void 主题色不能和界面分叉() throws IOException {
        JsonNode manifest = new ObjectMapper()
                .readTree(Files.readString(STATIC.resolve("manifest.json"), StandardCharsets.UTF_8));
        String themeColor = manifest.path("theme_color").asText("").toUpperCase();
        assertFalse(themeColor.isBlank(), "manifest 没有 theme_color");

        String css = Files.readString(STATIC.resolve("assets/zhiqu-ui.css"), StandardCharsets.UTF_8);
        int at = css.indexOf("--zq-primary:");
        assertTrue(at > 0, "在 zhiqu-ui.css 里找不到 --zq-primary —— 扫空了");
        String basePrimary = css.substring(at + "--zq-primary:".length(), css.indexOf(';', at))
                .trim().toUpperCase();

        assertTrue(themeColor.equals(basePrimary),
                "manifest 的 theme_color(" + themeColor + ") 和基础主题的 --zq-primary("
                        + basePrimary + ") 不一致。分叉的表现是安装成 PWA 之后"
                        + "状态栏颜色和应用里的主色对不上。");
    }
}
