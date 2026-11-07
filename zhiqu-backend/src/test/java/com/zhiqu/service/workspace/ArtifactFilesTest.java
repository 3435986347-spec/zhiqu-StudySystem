package com.zhiqu.service.workspace;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 比对临时空间（第一百一十六轮）。里面的东西是模型和命令写的，不能信。 */
class ArtifactFilesTest {

    @TempDir
    Path root;

    private static List<String> paths(List<ArtifactFiles.Generated> g) {
        return g.stream().map(ArtifactFiles.Generated::path).collect(Collectors.toList());
    }

    @Test
    @DisplayName("新建的、改过的算；没动的不算；只动了时间的不算；子目录路径用 /；内容和指纹对得上")
    void 新建和改过的算() throws Exception {
        Files.writeString(root.resolve("same.txt"), "不变");
        Files.writeString(root.resolve("edit.txt"), "旧");
        Files.writeString(root.resolve("touched.txt"), "内容不变");
        Map<String, ArtifactFiles.Stamp> before = ArtifactFiles.snapshot(root);
        Files.writeString(root.resolve("edit.txt"), "新");
        Files.setLastModifiedTime(root.resolve("touched.txt"), java.nio.file.attribute.FileTime.fromMillis(1_000_000));
        Files.createDirectories(root.resolve("sub/dir"));
        Files.writeString(root.resolve("sub/dir/new.py"), "print(1)\n");
        List<ArtifactFiles.Generated> out = ArtifactFiles.changes(root, before);
        assertEquals(List.of("edit.txt", "sub/dir/new.py"), paths(out));
        ArtifactFiles.Generated edit = out.get(0);
        assertEquals("新", new String(edit.content(), java.nio.charset.StandardCharsets.UTF_8));
        assertEquals(ArtifactFiles.sha256(edit.content()), edit.sha256());
        assertNull(edit.skipped());
    }

    @Test
    @DisplayName("软链不跟：链到外面的密钥、链到外面的目录都不会被存下来")
    void 软链不跟() throws Exception {
        Path outside = Files.createTempDirectory("zhiqu-outside-");
        Files.writeString(outside.resolve("id_rsa"), "SECRET-KEY");
        Map<String, ArtifactFiles.Stamp> before = ArtifactFiles.snapshot(root);
        Files.createSymbolicLink(root.resolve("key.txt"), outside.resolve("id_rsa"));
        Files.createSymbolicLink(root.resolve("dir-link"), outside);
        Files.writeString(root.resolve("real.txt"), "正常的");
        assertEquals(List.of("real.txt"), paths(ArtifactFiles.changes(root, before)));
    }

    @Test
    @DisplayName("比对之后被换成软链：打开时也不跟；比对之后长到超过上限：不要，不存半截")
    void 比对之后被换掉() throws Exception {
        Path outside = Files.createTempDirectory("zhiqu-outside-");
        Files.writeString(outside.resolve("id_rsa"), "SECRET-KEY");
        Path link = Files.createSymbolicLink(root.resolve("swapped.txt"), outside.resolve("id_rsa"));
        assertNull(ArtifactFiles.read(link));
        Path big = root.resolve("grew.bin");
        Files.write(big, new byte[(int) ArtifactFiles.MAX_FILE_BYTES + 1]);
        assertNull(ArtifactFiles.read(big));
    }

    @Test
    @Timeout(20)
    @DisplayName("管道不读：读它会一直卡住，后端的线程就没了")
    void 管道不读() throws Exception {
        Map<String, ArtifactFiles.Stamp> before = ArtifactFiles.snapshot(root);
        Process mk = new ProcessBuilder("mkfifo", root.resolve("hang.txt").toString()).start();
        assertEquals(0, mk.waitFor());
        Files.writeString(root.resolve("real.txt"), "正常的");
        assertEquals(List.of("real.txt"), paths(ArtifactFiles.changes(root, before)));
    }

    @Test
    @DisplayName("依赖和缓存目录不算：node_modules、.git、__pycache__、.venv 不进产物，写一半的临时文件也不算；.gitignore 这种名字是文件照算")
    void 依赖目录不算() throws Exception {
        Map<String, ArtifactFiles.Stamp> before = ArtifactFiles.snapshot(root);
        for (String d : List.of("node_modules/x", ".git/hooks", "__pycache__", ".venv/lib", "venv/lib", ".zhiqu/inputs")) {
            Files.createDirectories(root.resolve(d));
            Files.writeString(root.resolve(d).resolve("f.txt"), "x");
        }
        Files.writeString(root.resolve("a.py.zhiqu-tmp-123"), "x");
        Files.writeString(root.resolve(".gitignore"), "x");
        Files.createDirectories(root.resolve("src/node_modules_backup"));
        Files.writeString(root.resolve("src/node_modules_backup/keep.txt"), "x");
        assertEquals(List.of(".gitignore", "src/node_modules_backup/keep.txt"), paths(ArtifactFiles.changes(root, before)));
    }

    @Test
    @DisplayName("太大的不存但要说：单个超 5MB；一轮超 20MB 从超的那个起不存；正好 5MB 算放得下")
    void 上限() throws Exception {
        Map<String, ArtifactFiles.Stamp> before = ArtifactFiles.snapshot(root);
        byte[] exact = new byte[(int) ArtifactFiles.MAX_FILE_BYTES];
        Files.write(root.resolve("a-exact.bin"), exact);
        Files.write(root.resolve("b-big.bin"), new byte[(int) ArtifactFiles.MAX_FILE_BYTES + 1]);
        for (int i = 0; i < 4; i++) {
            Files.write(root.resolve("c" + i + ".bin"), exact);
        }
        List<ArtifactFiles.Generated> out = ArtifactFiles.changes(root, before);
        assertEquals(6, out.size());
        assertNotNull(out.get(0).content(), "正好 5MB 放得下");
        assertNull(out.get(1).content());
        assertTrue(out.get(1).skipped().contains("5MB"), out.get(1).skipped());
        assertNotNull(out.get(2).content());
        assertNotNull(out.get(4).content(), "加上 a-exact 正好 20MB");
        assertNull(out.get(5).content(), "第 5 个 5MB 超了 20MB");
        assertTrue(out.get(5).skipped().contains("20MB"), out.get(5).skipped());
    }

    @Test
    @DisplayName("文件太多：只存前面的，后面的说清楚")
    void 文件太多() throws Exception {
        Map<String, ArtifactFiles.Stamp> before = ArtifactFiles.snapshot(root);
        for (int i = 0; i < ArtifactFiles.MAX_SAVED + 5; i++) {
            Files.writeString(root.resolve(String.format("f%04d.txt", i)), "x");
        }
        List<ArtifactFiles.Generated> out = ArtifactFiles.changes(root, before);
        assertEquals(ArtifactFiles.MAX_SAVED, out.stream().filter(g -> g.content() != null).count());
        assertTrue(out.get(out.size() - 1).skipped().contains("太多"));
    }

    @Test
    @DisplayName("空的、不存在的目录不炸")
    void 空目录() {
        assertTrue(ArtifactFiles.snapshot(root).isEmpty());
        assertTrue(ArtifactFiles.snapshot(root.resolve("nope")).isEmpty());
        assertTrue(ArtifactFiles.snapshot(null).isEmpty());
        assertFalse(ArtifactFiles.changes(root, Map.of()).iterator().hasNext());
    }
}
