package com.zhiqu.service.workspace;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Locale;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 工作区的沙箱边界：把一个用户给的相对路径，解析成<b>确实可以读的那个文件</b>，否则拒绝。
 *
 * <h2>与 PrivateUploadPathGuard 的关系</h2>
 *
 * <p>路径那三条（normalize 防 {@code ../}、拒绝符号链接、只许普通文件）与
 * {@code service/ai/PrivateUploadPathGuard} 完全同源，那边每一条都有判据、都扰动见过红。
 * 这里没有复用那个类而是重写，因为两者的<b>边界语义不同</b>：那个按 {@code userId} 分目录，
 * 这个是全局单一根目录；那个的输入来自数据库，这个的输入来自模型。合并会让两边的注释
 * 互相说不清楚。
 *
 * <h2>这里多出来的两条</h2>
 *
 * <ul>
 *   <li><b>扩展名白名单</b> —— 挡的不是攻击者，是「顺手把 {@code .env} / {@code id_rsa} /
 *       {@code .pem} 喂进模型上下文」。白名单失败封闭，黑名单失败开放：漏掉一个后缀
 *       就泄漏一把私钥。</li>
 *   <li><b>单文件大小上限</b> —— 一个 20MB 的 minified bundle 进上下文既没用又贵。</li>
 * </ul>
 *
 * <h2>拒绝的理由要能说出口</h2>
 *
 * <p>返回 {@link Resolution}，把「为什么不行」带出来。工作区的使用者是人，
 * 而「读不到」有五种完全不同的原因，都回一个 null 的话，用户只会觉得这个功能坏了。
 */
public final class WorkspaceGuard {

    /** 拒绝的原因 —— 每一种对应一条判据。 */
    public enum Reason {
        OK,
        /** 路径为空。 */
        EMPTY,
        /** 解析后落在工作区之外（{@code ../} 往上跳，或给了绝对路径）。 */
        OUTSIDE_ROOT,
        /** 是符号链接 —— 链接本身在目录内，指向外面，前缀检查拦不住。 */
        SYMLINK,
        /** 不是普通文件（目录、设备文件、命名管道；读管道会把线程挂死）。 */
        NOT_REGULAR_FILE,
        /** 扩展名不在白名单里。 */
        EXTENSION_NOT_ALLOWED,
        /** 超过单文件大小上限。 */
        TOO_LARGE
    }

    /** 解析结果：要么给出可读的绝对路径，要么给出拒绝理由。 */
    public record Resolution(Path path, Reason reason) {
        public boolean ok() {
            return reason == Reason.OK && path != null;
        }

        static Resolution denied(Reason reason) {
            return new Resolution(null, reason);
        }
    }

    private final Path root;
    private final Set<String> allowedExtensions;
    private final long maxFileBytes;

    public WorkspaceGuard(Path root, Iterable<String> allowedExtensions, long maxFileBytes) {
        this.root = root.toAbsolutePath().normalize();
        this.allowedExtensions = toLowerSet(allowedExtensions);
        this.maxFileBytes = maxFileBytes;
    }

    private static Set<String> toLowerSet(Iterable<String> values) {
        return java.util.stream.StreamSupport.stream(values.spliterator(), false)
                .filter(v -> v != null && !v.isBlank())
                .map(v -> v.trim().toLowerCase(Locale.ROOT))
                .collect(Collectors.toUnmodifiableSet());
    }

    public Path root() {
        return root;
    }

    /** 解析一个<b>相对于工作区根</b>的路径。绝对路径一律按 OUTSIDE_ROOT 拒绝。 */
    public Resolution resolveReadable(String relativePath) {
        if (relativePath == null || relativePath.isBlank()) {
            return Resolution.denied(Reason.EMPTY);
        }
        Path candidate;
        try {
            Path given = Paths.get(relativePath.trim());
            // 绝对路径不接受：resolve 一个绝对路径会直接丢掉 root，前缀检查随后当然通过 ——
            // 这是路径拼接最经典的那个坑
            if (given.isAbsolute()) {
                return Resolution.denied(Reason.OUTSIDE_ROOT);
            }
            candidate = root.resolve(given).normalize();
        } catch (Exception e) {
            return Resolution.denied(Reason.OUTSIDE_ROOT);
        }
        if (!candidate.startsWith(root)) {
            return Resolution.denied(Reason.OUTSIDE_ROOT);
        }
        if (Files.isSymbolicLink(candidate)) {
            return Resolution.denied(Reason.SYMLINK);
        }
        if (!Files.isRegularFile(candidate)) {
            return Resolution.denied(Reason.NOT_REGULAR_FILE);
        }
        if (!extensionAllowed(candidate)) {
            return Resolution.denied(Reason.EXTENSION_NOT_ALLOWED);
        }
        try {
            if (Files.size(candidate) > maxFileBytes) {
                return Resolution.denied(Reason.TOO_LARGE);
            }
        } catch (IOException e) {
            return Resolution.denied(Reason.NOT_REGULAR_FILE);
        }
        return new Resolution(candidate, Reason.OK);
    }

    /**
     * 目录路径的解析（列目录用）。与文件的区别只有最后一步：要的是目录不是普通文件。
     *
     * <p>空字符串表示工作区根本身。
     */
    public Resolution resolveDirectory(String relativePath) {
        Path candidate;
        try {
            if (relativePath == null || relativePath.isBlank() || ".".equals(relativePath.trim())) {
                candidate = root;
            } else {
                Path given = Paths.get(relativePath.trim());
                if (given.isAbsolute()) {
                    return Resolution.denied(Reason.OUTSIDE_ROOT);
                }
                candidate = root.resolve(given).normalize();
            }
        } catch (Exception e) {
            return Resolution.denied(Reason.OUTSIDE_ROOT);
        }
        if (!candidate.startsWith(root)) {
            return Resolution.denied(Reason.OUTSIDE_ROOT);
        }
        if (Files.isSymbolicLink(candidate)) {
            return Resolution.denied(Reason.SYMLINK);
        }
        if (!Files.isDirectory(candidate)) {
            return Resolution.denied(Reason.NOT_REGULAR_FILE);
        }
        return new Resolution(candidate, Reason.OK);
    }

    /** 扩展名是否在白名单里。无扩展名的文件按文件名整体比（Makefile / Dockerfile）。 */
    public boolean extensionAllowed(Path file) {
        String name = file.getFileName().toString().toLowerCase(Locale.ROOT);
        int dot = name.lastIndexOf('.');
        String key = dot >= 0 && dot < name.length() - 1 ? name.substring(dot + 1) : name;
        return allowedExtensions.contains(key);
    }
}
