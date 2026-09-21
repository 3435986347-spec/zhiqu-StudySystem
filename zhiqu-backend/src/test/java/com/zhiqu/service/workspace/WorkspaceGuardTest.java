package com.zhiqu.service.workspace;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 工作区沙箱边界：六种逃逸方式，逐个钉。
 *
 * <h2>这个守卫的输入来自模型</h2>
 *
 * <p>{@code PrivateUploadPathGuard} 的输入是数据库里的一个字符串（写错了才出事）；
 * 这里的输入是<b>模型给的路径</b> —— 它会试各种写法，而且提示注入可以直接影响它。
 * 所以「拒绝的默认姿态」比那边更重要：任何一条不满足都拒绝，且说得出是哪一条。
 *
 * <h2>每条都要能单独红</h2>
 *
 * <p>六个条件删掉任意一个，「读文件」这个功能都照常工作 —— 只是多了一条出口。
 * 这正是它们各自需要一条判据的理由。
 */
class WorkspaceGuardTest {

    private static final List<String> EXTS = List.of("java", "md", "txt", "json");
    private static final long MAX = 1024L;

    private static WorkspaceGuard guardAt(Path root) {
        return new WorkspaceGuard(root, EXTS, MAX);
    }

    private static Path seed(Path dir, String name, String content) throws IOException {
        Files.createDirectories(dir);
        Path f = dir.resolve(name);
        Files.writeString(f, content, StandardCharsets.UTF_8);
        return f;
    }

    @Test
    void 工作区内的普通源码文件必须可读(@TempDir Path root) throws IOException {
        seed(root.resolve("src"), "Main.java", "class Main {}");
        WorkspaceGuard.Resolution r = guardAt(root).resolveReadable("src/Main.java");
        assertTrue(r.ok(),
                "正例：工作区内、白名单内、未超限的普通文件必须放行 —— 没有这条，"
                        + "「一律拒绝」也能让下面全绿，而整个功能不可用。实际理由：" + r.reason());
        assertEquals(root.resolve("src/Main.java").toRealPath(), r.path().toRealPath());
    }

    /** 扰动：去掉 normalize → 本条红（`../` 的字符串前缀是匹配 root 的）。 */
    @Test
    void 用相对路径跳出工作区必须被拒(@TempDir Path root) throws IOException {
        Path outside = seed(root.getParent(), "outside-secret.java", "不该被读到");
        WorkspaceGuard guard = guardAt(root);
        Files.createDirectories(root.resolve("src"));

        assertEquals(WorkspaceGuard.Reason.OUTSIDE_ROOT,
                guard.resolveReadable("../outside-secret.java").reason());
        assertEquals(WorkspaceGuard.Reason.OUTSIDE_ROOT,
                guard.resolveReadable("src/../../outside-secret.java").reason());
        assertTrue(Files.isRegularFile(outside), "前提：目标文件真的存在，否则拒绝的只是「文件不存在」");
    }

    /**
     * 接口只收<b>相对路径</b>：任何绝对路径都拒。
     *
     * <h2>这一条钉的是契约，不是安全边界 —— 说清楚免得下一个人误判</h2>
     *
     * <p>第一版判据给的是「指向工作区之外的绝对路径」，而那种情况
     * <b>即使去掉 {@code isAbsolute} 也仍被 {@code startsWith(root)} 挡住</b>：
     * {@code root.resolve(绝对路径)} 返回那个绝对路径本身，它当然不以 root 开头。
     * 于是那条判据是绿的，扰动也不红 —— 它测的不是它名字说的东西。
     *
     * <p>{@code isAbsolute} 唯一<b>独有</b>的作用，是拒绝指向工作区<b>内部</b>的绝对路径。
     * 那不是安全问题（那个文件本来就可读），而是接口契约：这个 API 说好了只收相对路径，
     * 混着收会让「路径相对于谁」变得含糊，而含糊正是路径类缺陷的温床。
     * 所以这一版用工作区<b>内部</b>的绝对路径来扰动，它才真的钉住那一条。
     */
    @Test
    void 只收相对路径(@TempDir Path root) throws IOException {
        Path inside = seed(root.resolve("src"), "Main.java", "class Main {}");
        WorkspaceGuard guard = guardAt(root);

        assertTrue(guard.resolveReadable("src/Main.java").ok(), "前提：这个文件用相对路径是读得到的");
        assertEquals(WorkspaceGuard.Reason.OUTSIDE_ROOT, guard.resolveReadable(inside.toString()).reason(),
                "即使指向工作区内部，绝对路径也要拒 —— 这个 API 只收相对路径。实际：" + inside);

        // 指向外部的绝对路径同样被拒（这一条由 startsWith 兜住，不依赖 isAbsolute）
        Path outside = seed(root.getParent(), "abs-secret.java", "不该被读到");
        assertEquals(WorkspaceGuard.Reason.OUTSIDE_ROOT, guard.resolveReadable(outside.toString()).reason());
    }

    /** 扰动：去掉 isSymbolicLink 判断 → 本条红。前缀检查对它无效：链接本身在目录内。 */
    @Test
    void 指向外部的软链必须被拒(@TempDir Path root) throws IOException {
        Path outside = seed(root.getParent(), "linked.java", "目录之外");
        Path link = root.resolve("looks-inside.java");
        Files.createDirectories(root);
        try {
            Files.createSymbolicLink(link, outside);
        } catch (UnsupportedOperationException | IOException e) {
            return;   // 文件系统不支持建软链就跳过，而不是假装通过
        }
        assertTrue(link.startsWith(root), "前提：链接本身确实在工作区内，前缀检查拦不住它");
        assertEquals(WorkspaceGuard.Reason.SYMLINK, guardAt(root).resolveReadable("looks-inside.java").reason());
    }

    /** 扰动：去掉扩展名白名单 → 本条红。挡的不是攻击者，是「顺手把 .env 喂进上下文」。 */
    @Test
    void 白名单之外的扩展名必须被拒(@TempDir Path root) throws IOException {
        seed(root, ".env", "DB_PASSWORD=hunter2");
        seed(root, "id_rsa", "-----BEGIN PRIVATE KEY-----");
        seed(root, "cert.pem", "-----BEGIN CERTIFICATE-----");
        WorkspaceGuard guard = guardAt(root);

        for (String name : new String[]{".env", "id_rsa", "cert.pem"}) {
            assertEquals(WorkspaceGuard.Reason.EXTENSION_NOT_ALLOWED, guard.resolveReadable(name).reason(),
                    name + " 不在白名单里，必须被拒 —— 白名单失败封闭，黑名单漏一个就泄漏一把私钥");
        }
    }

    /** 扰动：去掉大小检查 → 本条红。 */
    @Test
    void 超过上限的文件必须被拒(@TempDir Path root) throws IOException {
        seed(root, "big.java", "x".repeat((int) MAX + 1));
        seed(root, "small.java", "x".repeat((int) MAX - 1));
        WorkspaceGuard guard = guardAt(root);

        assertEquals(WorkspaceGuard.Reason.TOO_LARGE, guard.resolveReadable("big.java").reason());
        assertTrue(guard.resolveReadable("small.java").ok(),
                "反例：刚好在上限内的必须放行，否则「一律 TOO_LARGE」也能让上面绿");
    }

    /** 扰动：去掉 isRegularFile 判断 → 本条红。读一个命名管道会把线程挂死。 */
    @Test
    void 目录不是可读的文件(@TempDir Path root) throws IOException {
        Files.createDirectories(root.resolve("src.java"));   // 故意起个像文件的目录名
        assertEquals(WorkspaceGuard.Reason.NOT_REGULAR_FILE, guardAt(root).resolveReadable("src.java").reason());
    }

    @Test
    void 空路径与不存在的文件要说清楚是哪一种(@TempDir Path root) {
        WorkspaceGuard guard = guardAt(root);
        assertEquals(WorkspaceGuard.Reason.EMPTY, guard.resolveReadable(null).reason());
        assertEquals(WorkspaceGuard.Reason.EMPTY, guard.resolveReadable("   ").reason());
        assertEquals(WorkspaceGuard.Reason.NOT_REGULAR_FILE, guard.resolveReadable("nope.java").reason(),
                "「不存在」与「被挡住」是两回事，使用者要能分辨 —— 都回一个 null 的话，"
                        + "用户只会觉得这个功能坏了");
    }

    /** 列目录走另一条解析路径，同样的边界必须同样生效 —— 不能只在读文件那条路上防。 */
    @Test
    void 列目录的边界与读文件一致(@TempDir Path root) throws IOException {
        Files.createDirectories(root.resolve("src"));
        Files.createDirectories(root.getParent().resolve("outside-dir"));
        WorkspaceGuard guard = guardAt(root);

        assertTrue(guard.resolveDirectory("src").ok());
        assertTrue(guard.resolveDirectory("").ok(), "空路径表示工作区根本身");
        assertEquals(WorkspaceGuard.Reason.OUTSIDE_ROOT, guard.resolveDirectory("../outside-dir").reason());
        assertEquals(WorkspaceGuard.Reason.OUTSIDE_ROOT,
                guard.resolveDirectory(root.getParent().resolve("outside-dir").toString()).reason());
        assertFalse(guard.resolveDirectory("src/nope").ok());
    }
}
