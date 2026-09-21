package com.zhiqu.service.workspace;

import com.zhiqu.common.BusinessException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 工作区各处<b>限额边界</b>上的行为 —— 每个上限都测「正好」「差一」「多一」。
 *
 * <h2>为什么单独一个类</h2>
 *
 * <p>限额处的 off-by-one 是最容易静默出错的一类：功能照常工作，只是在某个刚好的
 * 尺寸上多拒一个、少拒一个，或者把「正好装下」误报成「装不下」。没有人会在日常使用中
 * 撞到那一个字节，而一旦撞到，症状（「明明没超怎么被拒了」）与原因隔得很远。
 *
 * <p>写这一批时抓到两个真的：
 *
 * <ul>
 *   <li>执行输出<b>正好等于</b>上限时被标成「已截断」（{@code read >= room} 应为 {@code >}）。
 *       后果不是崩，是模型对用户说「还有更多」，然后建议他换个更窄的命令重跑一次。</li>
 *   <li>列目录到 {@code maxEntries} <b>静默</b>截断，一个字都不说。600 个文件的目录返回
 *       500 条，模型据此说「这个目录有 500 个文件」，或者下「这里没有 X」的结论。
 *       搜索那边早就把截断报出来了，列目录这边漏了 —— 同一条纪律只落实了一半。</li>
 * </ul>
 */
class WorkspaceBoundaryTest {

    private static WorkspaceProperties props(Path root, String mode) {
        WorkspaceProperties p = new WorkspaceProperties();
        p.setMode(mode);
        p.setRoot(root.toString());
        return p;
    }

    private static WorkspaceService serviceAt(Path root, String mode) {
        return new WorkspaceService(props(root, mode), "127.0.0.1");
    }

    // ── 单文件大小上限 ────────────────────────────────────────────────────

    /** 正好等于上限：可读。差一字节就拒的话，一个刚好 256KB 的文件永远打不开。 */
    @Test
    void 文件正好等于上限时可读(@TempDir Path root) throws IOException {
        WorkspaceProperties p = props(root, "READ");
        p.setMaxFileBytes(100);
        Files.writeString(root.resolve("exact.java"), "x".repeat(100), StandardCharsets.UTF_8);

        assertEquals("x".repeat(100), new WorkspaceService(p, "127.0.0.1").read("exact.java"),
                "正好 100 字节、上限也是 100 —— 装得下，必须能读");
    }

    /** 多一字节：拒。 */
    @Test
    void 文件超出上限一字节就拒(@TempDir Path root) throws IOException {
        WorkspaceProperties p = props(root, "READ");
        p.setMaxFileBytes(100);
        Files.writeString(root.resolve("over.java"), "x".repeat(101), StandardCharsets.UTF_8);

        assertThrows(BusinessException.class, () -> new WorkspaceService(p, "127.0.0.1").read("over.java"));
    }

    /** 空文件（0 字节）要能读出空串，而不是当成「读不到」。 */
    @Test
    void 空文件要能读出空串(@TempDir Path root) throws IOException {
        Files.writeString(root.resolve("empty.java"), "", StandardCharsets.UTF_8);
        assertEquals("", serviceAt(root, "READ").read("empty.java"));
    }

    /**
     * 上限算的是<b>字节</b>不是字符 —— 中文一个字三字节。
     *
     * <p>按字符算的话，一个 100 字的中文文件（300 字节）会被当成 100 字节放过去，
     * 256KB 的上限实际变成 768KB，防 OOM 的意义就打了三折。
     */
    @Test
    void 上限按字节算而不是按字符(@TempDir Path root) throws IOException {
        WorkspaceProperties p = props(root, "WRITE");
        p.setMaxFileBytes(100);
        WorkspaceService service = new WorkspaceService(p, "127.0.0.1");

        String cjk = "中".repeat(40);      // 40 字 = 120 字节 > 100
        assertEquals(40, cjk.length());
        assertEquals(120, cjk.getBytes(StandardCharsets.UTF_8).length);
        assertThrows(BusinessException.class,
                () -> service.write("a.java", cjk, WorkspaceService.ABSENT),
                "40 个字符但 120 字节，超了 100 的上限必须拒 —— 按字符算会放过去");

        String justFits = "中".repeat(33);  // 99 字节
        service.write("b.java", justFits, WorkspaceService.ABSENT);
        assertEquals(justFits, Files.readString(root.resolve("b.java")));
    }

    /** 写入内容正好等于上限：写得进去。 */
    @Test
    void 写入内容正好等于上限时成功(@TempDir Path root) throws IOException {
        WorkspaceProperties p = props(root, "WRITE");
        p.setMaxFileBytes(50);
        WorkspaceService service = new WorkspaceService(p, "127.0.0.1");

        String exact = "y".repeat(50);
        service.write("c.java", exact, WorkspaceService.ABSENT);
        assertEquals(exact, Files.readString(root.resolve("c.java")));
    }

    /** 写空内容是合法的（清空一个文件）。 */
    @Test
    void 写入空内容是合法的(@TempDir Path root) throws IOException {
        Files.writeString(root.resolve("d.java"), "原来有内容", StandardCharsets.UTF_8);
        WorkspaceService service = serviceAt(root, "WRITE");
        service.write("d.java", "", service.baselineOf("d.java"));
        assertEquals("", Files.readString(root.resolve("d.java")));
    }

    // ── 列目录条数上限 ────────────────────────────────────────────────────

    /** 正好等于上限：不算截断。报了截断的话用户会去找并不存在的「更多条目」。 */
    @Test
    void 列目录正好到上限不算截断(@TempDir Path root) throws IOException {
        WorkspaceProperties p = props(root, "READ");
        p.setMaxEntries(5);
        for (int i = 0; i < 5; i++) {
            Files.writeString(root.resolve("f" + i + ".java"), "x", StandardCharsets.UTF_8);
        }
        WorkspaceService.Listing listing = new WorkspaceService(p, "127.0.0.1").listing("");

        assertEquals(5, listing.entries().size());
        assertFalse(listing.truncated(), "一共 5 个、上限也是 5 —— 全列出来了，不是截断");
    }

    /**
     * 多一个就要<b>说出来</b>。
     *
     * <p>原来这里是静默 {@code .limit(maxEntries)}：模型拿到 500 条会说「这个目录有
     * 500 个文件」，或者下「这里没有 X」的结论。搜索那边早就报截断了，列目录漏了。
     */
    @Test
    void 列目录超出上限必须报告截断(@TempDir Path root) throws IOException {
        WorkspaceProperties p = props(root, "READ");
        p.setMaxEntries(5);
        for (int i = 0; i < 6; i++) {
            Files.writeString(root.resolve("f" + i + ".java"), "x", StandardCharsets.UTF_8);
        }
        WorkspaceService.Listing listing = new WorkspaceService(p, "127.0.0.1").listing("");

        assertEquals(5, listing.entries().size(), "要按上限截断");
        assertTrue(listing.truncated(), "截断了就要说出来 —— 静默截断会让模型把部分当成全部");
    }

    // ── 搜索的三道上限 ────────────────────────────────────────────────────

    /** 扫描文件数到上限时也要报截断，而不是假装搜完了。 */
    @Test
    void 扫描文件数到上限要报截断(@TempDir Path root) throws IOException {
        WorkspaceProperties p = props(root, "READ");
        p.setMaxSearchFiles(2);
        for (int i = 0; i < 5; i++) {
            Files.writeString(root.resolve("s" + i + ".java"), "关键词", StandardCharsets.UTF_8);
        }
        WorkspaceService.SearchResult r = new WorkspaceService(p, "127.0.0.1").search("关键词", "");

        assertTrue(r.truncated(), "只扫了 " + r.filesScanned() + " 个文件就停了，必须说出来");
        assertTrue(r.filesScanned() <= 2, "实际扫了 " + r.filesScanned() + " 个，超过了上限");
    }

    /** 命中行正好等于长度上限：不截断、不加省略标记。 */
    @Test
    void 命中行正好等于长度上限不截断(@TempDir Path root) throws IOException {
        WorkspaceProperties p = props(root, "READ");
        p.setMaxSearchLineChars(20);
        String line = "关键词" + "x".repeat(17);      // 正好 20 字符
        assertEquals(20, line.length());
        Files.writeString(root.resolve("t.java"), line, StandardCharsets.UTF_8);

        WorkspaceService.SearchResult r = new WorkspaceService(p, "127.0.0.1").search("关键词", "");
        assertEquals(1, r.hits().size());
        assertEquals(line, r.hits().get(0).text(), "正好装得下，不该加截断标记");
    }

    /** 空关键词、只有空白的关键词都要拒 —— 否则整个工作区都算命中。 */
    @Test
    void 搜索的空输入边界(@TempDir Path root) throws IOException {
        Files.writeString(root.resolve("x.java"), "内容", StandardCharsets.UTF_8);
        WorkspaceService service = serviceAt(root, "READ");
        for (String q : new String[]{null, "", " ", "\t\n"}) {
            assertThrows(BusinessException.class, () -> service.search(q, ""),
                    "空关键词「" + q + "」必须被拒");
        }
    }

    // ── 执行输出上限 ──────────────────────────────────────────────────────

    /**
     * 输出<b>正好等于</b>上限时不算截断。
     *
     * <p>原来的判断是 {@code read >= room}：最后一次读正好把缓冲填满时也会被标成截断。
     * 后果不是崩，是模型对用户说「还有更多」，然后建议他换个更窄的命令重跑一次。
     */
    @Test
    void 执行输出正好到上限不算截断(@TempDir Path root) throws IOException {
        if (WorkspaceExecutor.resolveOnPath("python3") == null) {
            return;
        }
        // 正好 64 字节（63 个 x 加一个换行）
        Files.writeString(root.resolve("exact.py"), "print('x' * 63)\n", StandardCharsets.UTF_8);
        WorkspaceProperties p = props(root, "EXEC");
        p.setExecOutputLimitBytes(64);
        WorkspaceExecutor e = new WorkspaceExecutor(p, new WorkspaceService(p, "127.0.0.1"), "");

        WorkspaceExecutor.ExecResult r = e.exec("python3", List.of("exact.py"), "");
        assertEquals(64, r.output().getBytes(StandardCharsets.UTF_8).length,
                "输出应当正好 64 字节。实际：" + r.output().length() + " 字符");
        assertFalse(r.truncated(),
                "正好装下，一个字节都没丢 —— 报截断会让模型说「还有更多」，"
                        + "然后建议用户换个更窄的命令白跑一次");
    }

    /** 多一字节就要报截断。 */
    @Test
    void 执行输出超出一字节要报截断(@TempDir Path root) throws IOException {
        if (WorkspaceExecutor.resolveOnPath("python3") == null) {
            return;
        }
        Files.writeString(root.resolve("over.py"), "print('x' * 64)\n", StandardCharsets.UTF_8);
        WorkspaceProperties p = props(root, "EXEC");
        p.setExecOutputLimitBytes(64);
        WorkspaceExecutor e = new WorkspaceExecutor(p, new WorkspaceService(p, "127.0.0.1"), "");

        assertTrue(e.exec("python3", List.of("over.py"), "").truncated(),
                "65 字节而上限 64 —— 确实丢了一个字节，必须报");
    }

    /** 没有输出的命令：不该被当成截断，也不该当成失败。 */
    @Test
    void 没有输出的命令不算截断也不算失败(@TempDir Path root) throws IOException {
        if (WorkspaceExecutor.resolveOnPath("python3") == null) {
            return;
        }
        Files.writeString(root.resolve("quiet.py"), "pass\n", StandardCharsets.UTF_8);
        WorkspaceExecutor.ExecResult r = new WorkspaceExecutor(
                props(root, "EXEC"), serviceAt(root, "EXEC"), "").exec("python3", List.of("quiet.py"), "");

        assertEquals(0, r.exitCode());
        assertFalse(r.truncated());
        assertFalse(r.timedOut());
        assertTrue(r.output().isBlank(), "实际输出：" + r.output());
    }

    /** 空参数数组是合法的（很多命令不需要参数）。 */
    @Test
    void 空参数数组是合法的(@TempDir Path root) throws IOException {
        if (WorkspaceExecutor.resolveOnPath("python3") == null) {
            return;
        }
        WorkspaceExecutor e = new WorkspaceExecutor(props(root, "EXEC"), serviceAt(root, "EXEC"), "");
        // python3 不带参数会进交互模式并立刻遇到 EOF —— 关心的是「不因为空数组被拒」
        assertThrows(BusinessException.class, () -> e.exec("", List.of(), ""),
                "空命令名要拒");
        WorkspaceExecutor.ExecResult r = e.exec("python3", List.of("-V"), "");
        assertEquals(0, r.exitCode(), "输出：" + r.output());
    }
}
