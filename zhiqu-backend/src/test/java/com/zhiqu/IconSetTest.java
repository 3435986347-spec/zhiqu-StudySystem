package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 图标（第四十二轮，docs/ui-plan.md 第 2 步）。锐评里「玩具感」最直接的来源：导航、菜单、按钮里的图标是 Unicode 符号，
 * 每个来自不同字体、粗细基线都不一样。现在是 zhiqu-ui.js 里一套线性 SVG（ZQUI.icon / data-zq-icon / zqShared.icon）。
 */
class IconSetTest {

    private static final Path STATIC = Path.of("src/main/resources/static");
    /** 原来当图标用的那批符号。不在里面的：⌘（快捷键写法「⌘/Ctrl + 回车」）、✓（标签页标题「✓ 专注结束」）、→（正文里的箭头） */
    // ♡♥：参考计划的点赞原来是这两个字符（第五十七轮才看到 —— 这份名单里没有它们，扫过去是绿的）
    // ⚠：Wiki 健康检查的每一条、图谱的悬空链接、AI 助手的出错消息（第六十九轮，同样是名单里漏了）
    // 📁 📄：代码工作区的文件树、文件夹选择器（第七十八轮换成 ICONS 的 folder / file）
    private static final Pattern GLYPHS = Pattern.compile("[✦▦☰↻❏≣◈✉∿«»‹›⚙◐◑⏻✪＋↑↓←♡♥⚠]|📁|📄|>\\s*×\\s*<|'×'");

    private static List<Path> sources() throws IOException {
        List<Path> files = new ArrayList<>();
        try (Stream<Path> list = Files.list(STATIC)) {
            // 第四十六轮起落地页也扫（原来它的四张功能卡片和深浅色按钮 ◑ 还是符号，留着没换）
            list.filter(p -> p.toString().endsWith(".html")).sorted().forEach(files::add);
        }
        try (Stream<Path> walk = Files.walk(STATIC.resolve("assets"))) {
            walk.filter(p -> p.toString().endsWith(".js")).filter(p -> !p.toString().contains("/vendor/")).sorted().forEach(files::add);
        }
        return files;
    }

    private static String code(Path f) throws IOException {
        String s = Files.readString(f, StandardCharsets.UTF_8);
        return f.toString().endsWith(".js") ? SourceText.stripComments(s) : s.replaceAll("(?s)<!--.*?-->", "");
    }

    @Test
    @DisplayName("代码里用到的每个图标名都画得出来，data-zq-icon 占位会被填上（在 node 里真跑 zhiqu-ui.js）")
    void 图标都画得出来() throws Exception {
        Set<String> names = new TreeSet<>();
        Pattern quoted = Pattern.compile("'([a-z][a-z0-9-]*)'");
        for (Path f : sources()) {
            String c = code(f);
            Matcher call = Pattern.compile("\\bicon\\(([^()]*)\\)").matcher(c);
            while (call.find()) {
                // icon(opts.dir==='right'?'chevron-right':'chevron-left') 里的 'right' 是比较的对象，不是图标名
                Matcher q = quoted.matcher(call.group(1).replaceAll("[=!]==?\\s*'[^']*'", ""));
                while (q.find()) names.add(q.group(1));
            }
            Matcher ph = Pattern.compile("data-zq-icon=\"([a-z][a-z0-9-]*)\"").matcher(c);
            while (ph.find()) names.add(ph.group(1));
        }
        // NAV 的第三项是图标名（导航、头像菜单都从这里画）
        String ui = code(STATIC.resolve("assets/zhiqu-ui.js"));
        int navAt = ui.indexOf("var NAV = {");
        String nav = ui.substring(navAt, ui.indexOf("};", navAt));
        Matcher entry = Pattern.compile("\\['[^']+\\.html','[^']+','([^']+)'\\]").matcher(nav);
        int navIcons = 0;
        while (entry.find()) { names.add(entry.group(1)); navIcons++; }
        assertTrue(navIcons >= 11, "NAV 里只扫到 " + navIcons + " 个图标名");
        assertTrue(names.size() >= 20, "只扫到 " + names.size() + " 个图标名 —— 扫空了？" + names);
        List<String> args = new ArrayList<>(names);
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/icon-check.js"), STATIC.resolve("assets/zhiqu-ui.js"), args.toArray(new String[0])),
                "icon-check.js 没有全绿");
    }

    @Test
    @DisplayName("页面、壳、模块里不再有当图标用的 Unicode 符号（落地页留给第 8 步）")
    void 不再用符号当图标() throws IOException {
        List<Path> files = sources();
        assertTrue(files.size() >= 20, "只扫到 " + files.size() + " 个文件");   // 今天 13 个页面（不含落地页）+ 11 个脚本
        List<String> found = new ArrayList<>();
        for (Path f : files) {
            String c = code(f);
            int line = 1, last = 0;
            Matcher m = GLYPHS.matcher(c);
            while (m.find()) {
                for (int i = last; i < m.start(); i++) if (c.charAt(i) == '\n') line++;
                last = m.start();
                found.add(STATIC.relativize(f) + ":" + line + " " + m.group().trim());
            }
        }
        assertEquals(List.of(), found, "这些地方还在用符号当图标 —— 用 icon('名字') / data-zq-icon（zhiqu-ui.js 的 ICONS）");
    }

    @Test
    @DisplayName("模块用的 icon 来自壳（zqShared.icon），不自己去读 window.ZQUI")
    void 模块经壳拿图标() throws IOException {
        String api = SourceText.stripComments(Files.readString(STATIC.resolve("assets/zhiqu-api.js"), StandardCharsets.UTF_8));
        assertTrue(api.contains("icon: icon"), "zqShared 没把 icon 交给模块");
        List<String> direct = new ArrayList<>();
        try (Stream<Path> list = Files.list(STATIC.resolve("assets/pages"))) {
            for (Path p : list.filter(x -> x.toString().endsWith(".js")).sorted().collect(Collectors.toList())) {
                if (SourceText.stripComments(Files.readString(p, StandardCharsets.UTF_8)).contains("ZQUI.icon")) direct.add(p.getFileName().toString());
            }
        }
        assertEquals(List.of(), direct, "这些页面模块直接读 window.ZQUI.icon —— 照第三十一轮的规矩，壳给模块的东西只走 zqShared");
    }
}
