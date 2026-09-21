package com.zhiqu.service.ai;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 私有上传原件的读取守卫 —— <b>此前零覆盖</b>。
 *
 * <h2>为什么「行归属已经查过了」不足以放心</h2>
 *
 * <p>下载原件的路径上有三层：notebook 归属、source 行按 {@code userId} 限定、
 * 以及这里的路径校验。前两层查的是<b>数据库行</b>，而真正决定读哪个文件的是行里的
 * {@code file_path} 字符串。那个字符串只要有一次写错（落盘时文件名没消毒、将来某个导入
 * 功能直接写外部路径、一次迁移改错），读文件这一步就是任意文件读取 ——
 * 而前两层<b>完全看不出问题</b>：行确实属于这个用户，只是它指向了别处。
 *
 * <h2>三个条件删掉任意一个，下载功能都照常工作</h2>
 *
 * <p>这正是它需要判据的理由。本类的四个越权用例各对应一条：
 * 往上跳、软链外指、目录、以及别的用户的目录。最后一条正例挡住「一律拒绝」。
 */
class PrivateUploadPathGuardTest {

    private static final long ME = 7L;
    private static final long OTHER = 8L;

    private static Path seedFile(Path dir, String name, String content) throws IOException {
        Files.createDirectories(dir);
        Path file = dir.resolve(name);
        Files.writeString(file, content, StandardCharsets.UTF_8);
        return file;
    }

    @Test
    void 自己目录里的普通文件必须能读(@TempDir Path root) throws IOException {
        PrivateUploadPathGuard guard = new PrivateUploadPathGuard(root);
        Path mine = seedFile(guard.userRoot(ME), "note.txt", "我的资料");

        Path resolved = guard.resolveOwnedFile(ME, mine.toString());
        assertNotNull(resolved,
                "正例：自己目录里的普通文件必须放行 —— 没有这条，「一律拒绝」也能让下面全绿，"
                        + "而所有人的原件下载都会静默回落成导出文本");
        assertEquals(mine.toRealPath(), resolved.toRealPath());
    }

    /**
     * {@code ../} 往上跳必须被挡。
     *
     * <p>扰动：把 {@code normalize()} 去掉 → 本条红。注意<b>必须先 normalize 再比前缀</b>：
     * {@code <userRoot>/../../secret} 这个字符串的前缀是匹配 userRoot 的，不 normalize 就放行了。
     */
    @Test
    void 往上跳出目录必须被拒(@TempDir Path root) throws IOException {
        PrivateUploadPathGuard guard = new PrivateUploadPathGuard(root);
        Files.createDirectories(guard.userRoot(ME));
        Path secret = seedFile(root, "secret.txt", "不该被读到");

        String traversal = guard.userRoot(ME).resolve("..").resolve("..").resolve("secret.txt").toString();
        assertNull(guard.resolveOwnedFile(ME, traversal),
                "用 ../ 跳出自己的目录必须被拒。实际指向：" + traversal);
        // 下界：那个文件确实存在且可读，否则上面拒绝的只是「文件不存在」
        assertTrue(Files.isRegularFile(secret), "前提：目标文件真的存在，否则这条判据是空过的");
    }

    /**
     * 目录里的软链指向外面，必须被拒。
     *
     * <p>前缀检查对它<b>无效</b>：链接本身就在目录里。扰动：去掉
     * {@code Files.isSymbolicLink} 那一项 → 本条红。
     */
    @Test
    void 指向外部的软链必须被拒(@TempDir Path root) throws IOException {
        PrivateUploadPathGuard guard = new PrivateUploadPathGuard(root);
        Path userRoot = guard.userRoot(ME);
        Files.createDirectories(userRoot);
        Path outside = seedFile(root, "outside.txt", "目录之外");
        Path link = userRoot.resolve("looks-normal.txt");
        try {
            Files.createSymbolicLink(link, outside);
        } catch (UnsupportedOperationException | IOException e) {
            return;   // 某些文件系统不支持建软链；跳过而不是假装通过
        }

        assertTrue(link.startsWith(userRoot), "前提：链接本身确实在用户目录内，前缀检查拦不住它");
        assertNull(guard.resolveOwnedFile(ME, link.toString()),
                "目录内指向外部的软链必须被拒 —— 前缀检查对它无效，靠的是 isSymbolicLink 那一项");
    }

    @Test
    void 目录不是可下载的原件(@TempDir Path root) throws IOException {
        PrivateUploadPathGuard guard = new PrivateUploadPathGuard(root);
        Path sub = guard.userRoot(ME).resolve("subdir");
        Files.createDirectories(sub);

        assertNull(guard.resolveOwnedFile(ME, sub.toString()),
                "目录（以及设备文件、命名管道）不是原件；读一个管道会把线程挂死");
    }

    /**
     * 别人目录里的文件必须被拒 —— 这一条钉的是守卫<b>按用户分目录</b>，
     * 而不是只check「在上传根目录里」。
     */
    @Test
    void 别的用户目录里的文件必须被拒(@TempDir Path root) throws IOException {
        PrivateUploadPathGuard guard = new PrivateUploadPathGuard(root);
        Files.createDirectories(guard.userRoot(ME));
        Path theirs = seedFile(guard.userRoot(OTHER), "theirs.txt", "别人的资料");

        assertNull(guard.resolveOwnedFile(ME, theirs.toString()),
                "两个用户的目录都在上传根下 —— 只比到根为止的话，谁都能读谁的。实际：" + theirs);
        assertNotNull(guard.resolveOwnedFile(OTHER, theirs.toString()),
                "下界：这个文件对它的主人必须是可读的，否则上面拒绝的只是「文件不存在」");
    }

    @Test
    void 空路径与不存在的文件返回空而不是抛异常(@TempDir Path root) {
        PrivateUploadPathGuard guard = new PrivateUploadPathGuard(root);
        assertNull(guard.resolveOwnedFile(ME, null));
        assertNull(guard.resolveOwnedFile(ME, "   "));
        assertNull(guard.resolveOwnedFile(ME, guard.userRoot(ME).resolve("没有这个文件").toString()),
                "没有原件（URL / 手动笔记 / 历史数据）是正常情况，调用方要据此回落到导出解析文本，"
                        + "所以这里返回 null 而不是抛异常");
    }
}
