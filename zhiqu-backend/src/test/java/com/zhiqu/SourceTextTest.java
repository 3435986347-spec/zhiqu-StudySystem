package com.zhiqu;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@link SourceText#stripComments} 自己也要有判据 —— 它是十几条判据共用的地基。
 *
 * <h2>它出错的后果比它自己大得多</h2>
 *
 * <p>剥注释多剥了，被吃掉的<b>真代码</b>就从所有调用方眼里消失了。
 * 表现成什么取决于调用方写的是哪种断言：{@code assertTrue(contains(...))} 会红
 * （这次运气好，红了），而 {@code assertFalse(contains(...))} 会<b>假绿</b> ——
 * 一条本该发现问题的判据变成了永远通过。
 *
 * <p>2026-09-21 实际撞到：一条 {@code //} 注释里写了 {@code /api/workspace/**}，
 * 那个 {@code /**} 被当成块注释起点，一路吞到后面某段 javadoc 的 {@code *}{@code /}，
 * 中间几十行代码一起消失。
 */
class SourceTextTest {

    @Test
    void 行注释里的块注释起点不得吞掉后面的代码() {
        String source = String.join("\n",
                "        // /api/workspace/** 早就限了管理员",
                "        int keep = 1;",
                "        /** 后面这段 javadoc 的结尾曾经是那次吞噬的终点。 */",
                "        int alsoKeep = 2;");
        String stripped = SourceText.stripComments(source);

        assertTrue(stripped.contains("int keep = 1;"),
                "注释和代码之间的代码被吃掉了。剥注释多剥了一点，调用方就看不到那段代码 —— "
                        + "assertTrue 形式的判据会红，assertFalse 形式的会假绿。实际：" + stripped);
        assertTrue(stripped.contains("int alsoKeep = 2;"), "实际：" + stripped);
        assertFalse(stripped.contains("早就限了管理员"), "行注释本身要被剥掉。实际：" + stripped);
        assertFalse(stripped.contains("那次吞噬的终点"), "javadoc 要被剥掉。实际：" + stripped);
    }

    @Test
    void 普通的行注释与块注释都要剥掉() {
        String source = String.join("\n",
                "int a = 1; // 这是行注释",
                "/* 这是",
                "   块注释 */",
                "int b = 2;");
        String stripped = SourceText.stripComments(source);

        assertTrue(stripped.contains("int a = 1;") && stripped.contains("int b = 2;"), stripped);
        assertFalse(stripped.contains("这是行注释"), stripped);
        assertFalse(stripped.contains("块注释"), stripped);
    }

    /** URL 里的 {@code //} 不是注释 —— 否则一条 URL 会把整行后半截吞掉。 */
    @Test
    void URL里的双斜杠不算注释() {
        String stripped = SourceText.stripComments("String url = \"https://example.com/x\"; int keep = 1;");
        assertTrue(stripped.contains("int keep = 1;"), stripped);
        assertTrue(stripped.contains("example.com"), stripped);
    }
}
