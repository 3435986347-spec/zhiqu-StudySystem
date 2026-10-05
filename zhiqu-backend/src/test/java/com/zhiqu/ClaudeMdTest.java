package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.UncheckedIOException;
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
 * CLAUDE.md 只放规矩（第三十八轮，方案第 5 步）：每次会话整份读进上下文，原来 1529 行、成了日记。
 * 原文挪进了 docs/notes/ 和各轮的 docs/rounds/round-NN.md。这里钉住四件事 ——
 * 不超过 200 行；里面写到的路径都在；点名的判据都有这个文件；每一轮在 CLAUDE.md 和 docs/rounds/README.md 各有一行。
 * 后两件挡的是「照着 CLAUDE.md 去找，找不到」：它说的东西搬走或改名了，它自己不会知道。
 */
class ClaudeMdTest {

    private static final Path ROOT = Path.of("..");
    private static final int MAX_LINES = 200;

    private static String read(Path p) {
        try {
            return Files.readString(p, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    @Test
    @DisplayName("不超过 200 行：经过写进 docs/rounds/，细节写进 docs/notes/")
    void 行数() {
        long lines = read(ROOT.resolve("CLAUDE.md")).lines().count();
        assertTrue(lines <= MAX_LINES, "CLAUDE.md 有 " + lines + " 行（上限 " + MAX_LINES + "）—— 经过挪进那一轮的 docs/rounds/round-NN.md，细节挪进 docs/notes/");
        assertTrue(lines > 40, "CLAUDE.md 只有 " + lines + " 行 —— 读错文件了？");
    }

    @Test
    @DisplayName("写到的路径都在（docs/…、deploy/…、zhiqu-cli/… 和 Markdown 链接）")
    void 路径都在() {
        String md = read(ROOT.resolve("CLAUDE.md"));
        Set<String> paths = new TreeSet<>();
        Matcher m = Pattern.compile("(?<![\\w/.-])((?:docs|deploy|zhiqu-cli|zhiqu-backend|rag-service|conformance|tools)/[\\w./-]*)").matcher(md);
        while (m.find()) paths.add(m.group(1));
        // 链接只认正文里的：`boots[页面](zqShared)` 这种行内代码长得像链接，其实是一句代码
        Matcher link = Pattern.compile("\\]\\(([^)#\\s]+)\\)").matcher(md.replaceAll("`[^`]*`", "``"));
        while (link.find()) if (!link.group(1).contains("://")) paths.add(link.group(1));
        // 模板写法（round-NN、<页>）不是具体文件
        paths.removeIf(p -> p.contains("NN") || p.contains("<"));
        assertTrue(paths.size() >= 15, "只扫到 " + paths.size() + " 个路径 —— 正则扫空了？" + paths);
        List<String> missing = paths.stream().filter(p -> !Files.exists(ROOT.resolve(p.replaceAll("[.]$", "")))).collect(Collectors.toList());
        assertEquals(List.of(), missing, "CLAUDE.md 里写到的这些路径不存在（搬走了还是改名了？）");
    }

    @Test
    @DisplayName("点名的判据（XxxTest）都有这个文件")
    void 判据都在() throws IOException {
        String md = read(ROOT.resolve("CLAUDE.md"));
        Set<String> named = new TreeSet<>();
        Matcher m = Pattern.compile("\\b([A-Z][A-Za-z0-9]*Test)\\b").matcher(md);
        while (m.find()) named.add(m.group(1));
        assertTrue(named.size() >= 10, "只点名了 " + named.size() + " 个判据 —— 正则扫空了？" + named);
        Set<String> files;
        try (Stream<Path> walk = Files.walk(Path.of("src/test/java"))) {
            files = walk.map(p -> p.getFileName().toString()).filter(n -> n.endsWith(".java"))
                    .map(n -> n.substring(0, n.length() - ".java".length())).collect(Collectors.toSet());
        }
        List<String> missing = named.stream().filter(n -> !files.contains(n)).collect(Collectors.toList());
        assertEquals(List.of(), missing, "CLAUDE.md 点名的这些判据没有对应的文件");
    }

    @Test
    @DisplayName("每一轮在 CLAUDE.md 和 docs/rounds/README.md 各有一行")
    void 每一轮都有一行() throws IOException {
        String md = read(ROOT.resolve("CLAUDE.md"));
        String readme = read(ROOT.resolve("docs/rounds/README.md"));
        List<String> rounds;
        try (Stream<Path> list = Files.list(ROOT.resolve("docs/rounds"))) {
            rounds = list.map(p -> p.getFileName().toString()).filter(n -> n.matches("round-\\d+\\.md")).sorted().collect(Collectors.toList());
        }
        assertTrue(rounds.size() >= 30, "docs/rounds/ 下只扫到 " + rounds.size() + " 轮");
        List<String> problems = new ArrayList<>();
        for (String r : rounds) {
            if (!md.contains("](docs/rounds/" + r + ")")) problems.add("CLAUDE.md 少了 " + r);
            if (!readme.contains("](" + r + ")")) problems.add("README.md 少了 " + r);
        }
        assertEquals(List.of(), problems, "每一轮收口时在 CLAUDE.md 末尾和 docs/rounds/README.md 各加一行");
    }

    @Test
    @DisplayName("CLAUDE.md 写的缓存令牌就是现在用的那个")
    void 缓存令牌() {
        String md = read(ROOT.resolve("CLAUDE.md"));
        Matcher said = Pattern.compile("现在是 `([^`]+)`").matcher(md);
        assertTrue(said.find(), "CLAUDE.md 里找不到「现在是 `<令牌>`」那一句");
        Matcher real = Pattern.compile("const ZHIQU_CACHE = 'zhiqu-shell-v([^']+)'")
                .matcher(read(Path.of("src/main/resources/static/service-worker.js")));
        assertTrue(real.find(), "service-worker.js 里找不到 ZHIQU_CACHE");
        assertEquals(real.group(1), said.group(1), "CLAUDE.md 说的缓存令牌不是现在用的 —— 换令牌时这一句一起改");
    }
}
