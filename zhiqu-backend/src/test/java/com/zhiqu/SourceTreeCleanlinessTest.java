package com.zhiqu;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@code src/} 下不许有 iCloud 的冲突副本（{@code Foo 2.java}、{@code zhiqu-api 2.js}）。
 *
 * <h2>为什么值得一条判据，而不是「注意一下」</h2>
 *
 * <p>这个仓库在 {@code ~/Desktop} 下，被 iCloud 同步。CLAUDE.md 早就记了它会往 {@code target/}
 * 里丢 {@code X 2.class}。2026-09-21 第一次<b>落进了 {@code src/}</b>：连续快速改同一个文件时，
 * iCloud 把中间状态存成了 {@code AiServiceImpl 2.java} / {@code 3.java} / {@code 4.java}。
 *
 * <p>Java 的副本会大声报错（「类重复」），不需要判据。<b>静态资源的副本是静默的</b>：
 * {@code static/assets/zhiqu-api 2.js} 照样会被打进 JAR，然后以
 * {@code /assets/zhiqu-api%202.js} 对外提供一份旧的应用外壳 —— 没有任何报错，
 * 而它是一份过期的、可能含有已修掉的 bug 的前端代码。
 * {@code static/dashboard 2.html} 还会带着<b>旧的缓存令牌</b>混进来。
 *
 * <p>所以这条判据只管 {@code src/}，不管 {@code target/}（那是构建产物，clean 掉就行）。
 *
 * <p>扰动：{@code touch "src/main/resources/static/x 2.js"} → 本条红。
 */
class SourceTreeCleanlinessTest {

    private static final Path SRC = Path.of("src");

    /** 「名字 空格 数字.扩展名」—— iCloud 冲突副本的固定命名。 */
    private static final Pattern CONFLICT_COPY = Pattern.compile(".+ \\d+\\.[A-Za-z0-9]+$");

    @Test
    void 源码树里不得有iCloud冲突副本() throws IOException {
        List<String> copies = new ArrayList<>();
        int scanned = 0;
        try (Stream<Path> all = Files.walk(SRC)) {
            for (Path file : all.filter(Files::isRegularFile).sorted().toList()) {
                scanned++;
                if (CONFLICT_COPY.matcher(file.getFileName().toString()).matches()) {
                    copies.add(file.toString());
                }
            }
        }
        // 下限：扫空和扫干净长得一样。src 下的文件数远不止这个量级。
        assertTrue(scanned > 200, "只扫到 " + scanned + " 个文件 —— 遍历多半坏了，这条判据什么都没看到");

        assertEquals(List.of(), copies,
                "src/ 下有 iCloud 冲突副本。Java 的会报「类重复」，静态资源的不会 —— "
                        + "它会被原样打进 JAR，以带空格的地址对外提供一份过期的前端外壳，"
                        + "HTML 副本还会带着旧的缓存令牌。直接删掉它们："
                        + "find . -name '* [0-9].*' -not -path './.git/*' -delete");
    }
}
