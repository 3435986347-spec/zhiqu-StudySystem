package com.zhiqu.service.workspace;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/**
 * 一轮前后比对临时空间，找出新增和改过的文件（第一百一十六轮）。
 *
 * <p>临时空间里的东西是模型和命令写的，不能信：只认普通文件。软链不跟（链到别处的密钥会被当成产物存下来）、
 * 管道不读（读它会一直卡住），打开时再用 NOFOLLOW 防一次（比对和读之间被换掉）。
 */
public final class ArtifactFiles {
    private static final Logger log = LoggerFactory.getLogger(ArtifactFiles.class);

    public static final long MAX_FILE_BYTES = 5L * 1024 * 1024;
    public static final long MAX_BATCH_BYTES = 20L * 1024 * 1024;
    public static final long MAX_ACCOUNT_BYTES = 200L * 1024 * 1024;
    public static final int MAX_SCANNED = 5000;
    public static final int MAX_SAVED = 100;
    private static final Set<String> SKIPPED_DIRS = Set.of(".git", "node_modules", "__pycache__", ".venv", "venv", ".zhiqu");

    /** 指纹：小文件是内容的 SHA-256；放不下的不读内容（反正不存），大小 + 修改时间够判断变没变 */
    public record Stamp(long size, String fingerprint) {
    }

    /** content 为 null 就是没存，skipped 说为什么 */
    public record Generated(String path, long size, String sha256, byte[] content, String skipped) {
        public Generated notStored(String why) {
            return new Generated(path, size, "", null, why);
        }
    }

    private ArtifactFiles() {
    }

    public static Map<String, Stamp> snapshot(Path root) {
        Map<String, Stamp> out = new TreeMap<>();
        if (root == null) {
            return out;
        }
        try {
            Files.walkFileTree(root, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                    return SKIPPED_DIRS.contains(dir.getFileName().toString()) ? FileVisitResult.SKIP_SUBTREE : FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                    if (out.size() >= MAX_SCANNED) {
                        return FileVisitResult.TERMINATE;
                    }
                    if (attrs.isRegularFile() && !file.getFileName().toString().contains(".zhiqu-tmp-")) {
                        out.put(relative(root, file), stamp(file, attrs));
                    }
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFileFailed(Path file, IOException e) {
                    return FileVisitResult.CONTINUE;   // 读不了的（权限、半路被删）不算
                }
            });
        } catch (IOException e) {
            log.warn("比对临时空间失败：{}", e.toString());
        }
        return out;
    }

    /** 这个账号的总量在存的时候判（AiWorkspaceServiceImpl#saveGeneratedFiles，要查库） */
    public static List<Generated> changes(Path root, Map<String, Stamp> before) {
        Map<String, Stamp> after = snapshot(root);
        List<Generated> out = new ArrayList<>();
        long left = MAX_BATCH_BYTES;
        int saved = 0;
        for (Map.Entry<String, Stamp> e : after.entrySet()) {
            if (e.getValue().equals(before.get(e.getKey()))) {
                continue;
            }
            long size = e.getValue().size();
            String skipped = size > MAX_FILE_BYTES ? "超过单个文件 5MB 的上限"
                    : saved >= MAX_SAVED ? "这一轮生成的文件太多（只存前 " + MAX_SAVED + " 个）"
                    : size > left ? "这一轮生成的文件超过了 20MB"
                    : null;
            byte[] content = null;
            if (skipped == null) {
                content = read(root.resolve(e.getKey()));
                if (content == null) {
                    skipped = "读不了";
                } else {
                    left -= content.length;
                    saved++;
                }
            }
            out.add(new Generated(e.getKey(), size, skipped == null ? sha256(content) : "", content, skipped));
        }
        return out;
    }

    private static Stamp stamp(Path file, BasicFileAttributes attrs) {
        long size = attrs.size();
        if (size > MAX_FILE_BYTES) {
            return new Stamp(size, "mtime:" + attrs.lastModifiedTime().toMillis());
        }
        byte[] content = read(file);
        return new Stamp(size, content == null ? "unreadable" : sha256(content));
    }

    /** 比对之后被换成软链的不读；多读一个字节：长大到超过上限的不要 */
    static byte[] read(Path file) {
        try (InputStream in = Files.newInputStream(file, LinkOption.NOFOLLOW_LINKS)) {
            byte[] bytes = in.readNBytes((int) MAX_FILE_BYTES + 1);
            return bytes.length > MAX_FILE_BYTES ? null : bytes;
        } catch (IOException | RuntimeException e) {
            return null;
        }
    }

    private static String relative(Path root, Path file) {
        return root.relativize(file).toString().replace(java.io.File.separatorChar, '/');
    }

    public static String sha256(byte[] content) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(content));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** 给产物卡片和最终回答用的一行 */
    public static Map<String, Object> row(Long fileId, Generated g) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", fileId);
        m.put("path", g.path());
        m.put("size", g.size());
        if (g.skipped() != null) {
            m.put("skipped", g.skipped());
        }
        return m;
    }
}
