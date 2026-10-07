package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 首页轮播（第四十六轮）。用户 2026-10-06：「主页轮播图需要改一下」→「截图要换，轮播样式也改」。
 * 原来四张图是 10 月 4 日截的改版前的样子、只有浅色一套（页面切到深色还是白图）；说明文字压在图片底部的深色渐变上、圆点也压在图上；
 * 4.5 秒横着滑一张，鼠标停在上面、系统设了「减少动态效果」、标签页在后台都照样滑。行为在 home-tour-check.js 里真跑。
 */
class HomeCarouselTest {

    private static final Path STATIC = Path.of("src/main/resources/static");

    private static String html() throws IOException {
        return Files.readString(STATIC.resolve("index.html"), StandardCharsets.UTF_8);
    }

    /** WebP 的宽高（VP8 / VP8L / VP8X 三种都认）；不是 WebP 返回 null */
    static int[] webpSize(Path file) throws IOException {
        byte[] b = Files.readAllBytes(file);
        if (b.length < 30 || !new String(b, 0, 4, StandardCharsets.US_ASCII).equals("RIFF") || !new String(b, 8, 4, StandardCharsets.US_ASCII).equals("WEBP")) return null;
        String chunk = new String(b, 12, 4, StandardCharsets.US_ASCII);
        switch (chunk) {
            case "VP8 ":   // 有损：帧头 3 字节 + 起始码 9d 01 2a，之后两个 14 位的宽高
                return new int[]{((b[26] & 0xff) | (b[27] & 0xff) << 8) & 0x3fff, ((b[28] & 0xff) | (b[29] & 0xff) << 8) & 0x3fff};
            case "VP8L": {   // 无损：签名 0x2f 之后，宽 -1、高 -1 各 14 位
                int bits = (b[21] & 0xff) | (b[22] & 0xff) << 8 | (b[23] & 0xff) << 16 | (b[24] & 0xff) << 24;
                return new int[]{(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1};
            }
            case "VP8X":   // 扩展：画布宽 -1、高 -1 各 24 位
                return new int[]{((b[24] & 0xff) | (b[25] & 0xff) << 8 | (b[26] & 0xff) << 16) + 1, ((b[27] & 0xff) | (b[28] & 0xff) << 8 | (b[29] & 0xff) << 16) + 1};
            default:
                return null;
        }
    }

    @Test
    @DisplayName("每张都有浅、深两张截图，文件在、是 2048 × 1280 的 WebP；页签和图片一一对应；shots 目录里没有没人用的旧图")
    void 截图() throws IOException {
        String html = html();
        Matcher tab = Pattern.compile("<button type=\"button\" role=\"tab\" id=\"(zq-tour-tab-\\d+)\" aria-controls=\"(zq-tour-slide-\\d+)\"").matcher(html);
        List<String> controls = new ArrayList<>();
        while (tab.find()) controls.add(tab.group(2));
        Matcher fig = Pattern.compile("<figure class=\"zq-tour-slide[^\"]*\" id=\"(zq-tour-slide-\\d+)\" role=\"tabpanel\" aria-labelledby=\"zq-tour-tab-\\d+\" data-cap=\"([^\"]+)\">([\\s\\S]*?)</figure>").matcher(html);
        List<String> slides = new ArrayList<>();
        TreeSet<String> used = new TreeSet<>();
        List<String> bad = new ArrayList<>();
        while (fig.find()) {
            slides.add(fig.group(1));
            String body = fig.group(3);
            for (String theme : List.of("light", "dark")) {
                Matcher img = Pattern.compile("<img class=\"zq-shot-" + theme + "\" src=\"assets/shots/([a-z-]+-" + theme + "\\.webp)\\?v=[^\"]+\" alt=\"([^\"]+)\" width=\"2048\" height=\"1280\" loading=\"lazy\"").matcher(body);
                if (!img.find()) { bad.add(fig.group(1) + " 没有" + theme + "那张（或者少了宽高 / 懒加载）"); continue; }
                Path file = STATIC.resolve("assets/shots/" + img.group(1));
                used.add(img.group(1));
                int[] size = Files.exists(file) ? webpSize(file) : null;
                if (size == null) bad.add(img.group(1) + " 不在或不是 WebP");
                else if (size[0] != 2048 || size[1] != 1280) bad.add(img.group(1) + " 是 " + size[0] + " × " + size[1]);
            }
        }
        assertTrue(slides.size() >= 4, "只找到 " + slides.size() + " 张");
        assertEquals(slides, controls, "页签和图片对不上");
        assertEquals(List.of(), bad);
        try (Stream<Path> files = Files.list(STATIC.resolve("assets/shots"))) {
            TreeSet<String> onDisk = files.map(p -> p.getFileName().toString()).collect(Collectors.toCollection(TreeSet::new));
            assertEquals(used, onDisk, "shots 目录里的图和首页用到的不一致（旧图没删，或者引用了不存在的图）");
        }
    }

    @Test
    @DisplayName("样子：字不压在图上；看不见的那一套 display:none（懒加载就不下载）；叠在同一格淡入淡出；减少动态效果时不过渡")
    void 样子() throws IOException {
        String html = html();
        assertFalse(html.contains("<figcaption"), "说明又压回图片上了");
        assertFalse(html.contains("zq-dots"), "圆点又压回图片上了");
        assertTrue(html.contains("html[data-zq-mode=\"dark\"] .zq-shot-light,html:not([data-zq-mode=\"dark\"]) .zq-shot-dark{display:none;}"),
                "浅 / 深两套截图没有跟着页面的明暗换（或者看不见的那一套没有 display:none，会一起下载）");
        assertTrue(html.contains(".zq-tour-slide{grid-area:1/1;") && html.contains(".zq-tour-slide.is-on{opacity:1;"), "几张图没有叠在同一格里淡入淡出");
        assertTrue(html.contains("@media (prefers-reduced-motion:reduce){ .zq-tour-slide,.zq-tour-slide.is-on{transition:none;} }"), "减少动态效果时还在淡入淡出");
        assertTrue(html.contains("<p class=\"zq-tour-cap\" id=\"zq-tour-cap\">"), "图片外面那一行说明不见了");
    }

    @Test
    @DisplayName("行为（在 node 里真跑 index.html 里那段脚本）：6 秒换一张，停在上面 / 焦点在里面 / 后台 / 减少动态效果不换，点过按过不再自己换，左右键走")
    void 行为() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/home-tour-check.js"), STATIC.resolve("index.html")), "home-tour-check.js 没有全绿");
    }

    @Test
    @DisplayName("落地页加载 zhiqu-ui.js（功能卡片和深浅色按钮的图标由它画，悬停提示也是它）")
    void 图标有人画() throws IOException {
        String html = html();
        int ui = html.indexOf("<script src=\"assets/zhiqu-ui.js?v=");
        int api = html.indexOf("<script src=\"assets/zhiqu-api.js?v=");
        assertTrue(ui > 0 && api > ui, "落地页没加载 zhiqu-ui.js（或者在 zhiqu-api.js 后面）—— data-zq-icon 的占位没人填，功能卡片上空着一块");
        Matcher ph = Pattern.compile("data-zq-icon=\"([a-z-]+)\"").matcher(html);
        int n = 0;
        while (ph.find()) n++;
        assertEquals(5, n, "落地页应该有 5 个图标占位（四张功能卡片 + 深浅色按钮）");
    }
}
