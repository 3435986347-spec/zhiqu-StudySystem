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

import static org.junit.jupiter.api.Assertions.assertEquals;
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

    @Test
    @DisplayName("favicon.ico 和 Windows 的 zhiqu.ico 是真的图标：ICO 头、每一张都是解得开的 PNG、要的尺寸都在")
    void 图标文件是真的图标() throws IOException {
        // 第七十二轮之前网页的 favicon.ico 是 6 个字节的文本「zhiqu」（9 月 2 日的占位）：
        // 每一页的第一个 rel="icon" 都指着它，文件在、引用也在 —— 上面两条都照不出来，只能看文件本身。
        assertIco(STATIC.resolve("favicon.ico"), List.of(16, 32, 48));
        assertIco(Path.of("..", "deploy", "desktop", "icon", "zhiqu.ico"), List.of(16, 32, 48, 64, 128, 256));
    }

    @Test
    @DisplayName("清单和页面里写的图标尺寸就是文件的实际像素（换设计稿时放错一张会对不上）")
    void 图标尺寸和写的一致() throws IOException {
        JsonNode manifest = new ObjectMapper()
                .readTree(Files.readString(STATIC.resolve("manifest.json"), StandardCharsets.UTF_8));
        List<String> wrong = new ArrayList<>();
        int checked = 0;
        for (JsonNode icon : manifest.get("icons")) {
            String size = pngSize(Files.readAllBytes(STATIC.resolve(icon.path("src").asText()))), declared = icon.path("sizes").asText();
            checked++;
            if (!size.equals(declared)) wrong.add(icon.path("src").asText() + " 写的 " + declared + "、实际 " + size);
        }
        String touch = pngSize(Files.readAllBytes(STATIC.resolve("assets/icons/apple-touch-icon.png")));
        if (!touch.equals("180x180")) wrong.add("apple-touch-icon.png 实际 " + touch + "（iOS 要 180x180）");
        assertTrue(checked >= 3, "清单里只有 " + checked + " 张图标");
        assertTrue(wrong.isEmpty(), "图标尺寸对不上：" + wrong);
    }

    private static final Path DESKTOP_ICON = Path.of("..", "deploy", "desktop", "icon");

    @Test
    @DisplayName("桌面应用的图标母版（第七十六轮）：icon-1024.png 是 1024×1024、缩一半就是网页用的 icon-512.png；打包脚本把它交给 MakeIcon，MakeIcon 认 1024")
    void 图标母版是1024() throws IOException {
        // 第七十二轮设计稿最大只有 512，macOS 图标最大那一档（512@2x，1024 像素）只能从 512 放大；用户补来了 1024 和矢量稿
        byte[] master = Files.readAllBytes(DESKTOP_ICON.resolve("icon-1024.png"));
        assertEquals("1024x1024", pngSize(master), "icon-1024.png 不是 1024×1024");
        java.awt.image.BufferedImage big = javax.imageio.ImageIO.read(new java.io.ByteArrayInputStream(master));
        java.awt.image.BufferedImage small = javax.imageio.ImageIO.read(STATIC.resolve("assets/icons/icon-512.png").toFile());
        double diff = halfScaleDiff(big, small);
        // 同一张图缩一半再比，差在线条的抗锯齿边上（实测 0.48 / 255）；换了设计 / 放错了图会差几十
        assertTrue(diff < 2.0, "icon-1024.png 缩一半和网页的 icon-512.png 平均差 " + diff + " / 255 —— 不是同一张图（放错了设计稿？）");
        String pack = Files.readString(Path.of("..", "deploy", "desktop", "package-macos-native.sh"), StandardCharsets.UTF_8);
        assertTrue(pack.contains("\"$ICON_TOOL\" \"$ROOT/deploy/desktop/icon/icon-1024.png\" \\"), "打包脚本没把 1024 的母版交给 MakeIcon（又拿 512 放大了）");
        String tool = SourceText.stripComments(Files.readString(DESKTOP_ICON.resolve("MakeIcon.swift"), StandardCharsets.UTF_8));
        assertTrue(tool.contains("guard master.width == 1024 && master.height == 1024 else {"), "MakeIcon 不认 1024 的母版");
    }

    @Test
    @DisplayName("矢量稿 icon.svg（第七十六轮，留档的设计稿）：是 SVG、底色和母版一样、没有脚本 / 事件 / 外链")
    void 矢量稿是干净的SVG() throws IOException {
        String svg = Files.readString(DESKTOP_ICON.resolve("icon.svg"), StandardCharsets.UTF_8);
        assertTrue(svg.startsWith("<svg ") && svg.contains("viewBox=\"0 0 100 100\""), "icon.svg 不是那张 100×100 画布的 SVG");
        assertTrue(svg.contains("<rect width=\"100\" height=\"100\" rx=\"22\" fill=\"#18181B\">"), "矢量稿的底不是母版那个近黑圆角方块（#18181B）");
        java.util.regex.Matcher bad = java.util.regex.Pattern.compile("(?i)<script|\\son[a-z]+\\s*=|href\\s*=\\s*[\"'](?!#)").matcher(svg);
        assertFalse(bad.find(), "矢量稿里有脚本 / 事件 / 外链：" + (bad.find(0) ? bad.group() : ""));
    }

    /** 大图按 2×2 取平均缩一半，和小图逐像素（四个通道）比，回平均差（0–255） */
    private static double halfScaleDiff(java.awt.image.BufferedImage big, java.awt.image.BufferedImage small) {
        assertEquals(big.getWidth(), small.getWidth() * 2, "大图不是小图的两倍宽");
        double sum = 0;
        for (int y = 0; y < small.getHeight(); y++) {
            for (int x = 0; x < small.getWidth(); x++) {
                int q = small.getRGB(x, y);
                for (int shift = 0; shift < 32; shift += 8) {
                    int acc = 0;
                    for (int d = 0; d < 4; d++) acc += big.getRGB(x * 2 + d % 2, y * 2 + d / 2) >>> shift & 255;
                    sum += Math.abs(acc / 4 - (q >>> shift & 255));
                }
            }
        }
        return sum / (small.getWidth() * small.getHeight() * 4.0);
    }

    private static void assertIco(Path file, List<Integer> required) throws IOException {
        byte[] b = Files.readAllBytes(file);
        assertTrue(b.length >= 22 && b[0] == 0 && b[1] == 0 && b[2] == 1 && b[3] == 0,
                file + " 不是 ICO（开头不是 00 00 01 00，一共 " + b.length + " 字节）");
        int count = (b[4] & 0xff) | (b[5] & 0xff) << 8;
        List<Integer> sizes = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            int at = 6 + 16 * i;
            int w = b[at] & 0xff;
            int length = java.nio.ByteBuffer.wrap(b, at + 8, 8).order(java.nio.ByteOrder.LITTLE_ENDIAN).getInt();
            int offset = java.nio.ByteBuffer.wrap(b, at + 12, 4).order(java.nio.ByteOrder.LITTLE_ENDIAN).getInt();
            assertTrue(offset > 0 && offset + length <= b.length, file + " 第 " + (i + 1) + " 张超出文件");
            byte[] image = java.util.Arrays.copyOfRange(b, offset, offset + length);
            int px = w == 0 ? 256 : w;
            assertTrue(pngSize(image).equals(px + "x" + px), file + " 第 " + (i + 1) + " 张写的 " + px + "，图是 " + pngSize(image));
            sizes.add(px);
        }
        assertTrue(sizes.containsAll(required), file + " 里的尺寸 " + sizes + " 缺了 " + required);
    }

    /** PNG 的宽 x 高（IHDR 在固定位置）；不是 PNG 就回「不是 PNG」。 */
    private static String pngSize(byte[] png) {
        if (png.length < 24 || (png[0] & 0xff) != 0x89 || png[1] != 'P' || png[2] != 'N' || png[3] != 'G') return "不是 PNG";
        java.nio.ByteBuffer ihdr = java.nio.ByteBuffer.wrap(png, 16, 8);
        return ihdr.getInt() + "x" + ihdr.getInt();
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
