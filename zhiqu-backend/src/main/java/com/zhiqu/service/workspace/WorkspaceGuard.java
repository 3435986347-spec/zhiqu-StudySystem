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
        TOO_LARGE,
        /** 写入专用：目标的上级目录不存在。写入<b>不</b>替用户造目录，见 resolveWritable。 */
        PARENT_NOT_FOUND
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
        // root 存 realpath：包含性检查要在「软链都解开之后」的世界里做，两边必须同一个世界。
        // 只 realpath 候选路径而不 realpath root，在 macOS 上会全面失效 ——
        // /tmp 实际是 /private/tmp 的软链，正常文件会被判成「超出工作区」。
        this.root = realPathOf(root.toAbsolutePath().normalize());
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
        // 软链判定要排在包含性之前：最后一段本身是软链时，理由该说「这是软链」，
        // 而不是含混的「超出工作区」—— 两种情况用户要做的事不一样。
        if (Files.isSymbolicLink(candidate)) {
            return Resolution.denied(Reason.SYMLINK);
        }
        if (!containedAfterSymlinks(candidate)) {
            return Resolution.denied(Reason.OUTSIDE_ROOT);
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
        if (!containedAfterSymlinks(candidate)) {
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

    /**
     * 解开路径上<b>每一段</b>的软链之后，它还在工作区里吗。
     *
     * <h2>为什么不能只 normalize 再 startsWith</h2>
     *
     * <p>{@code normalize()} 是纯字符串运算，不碰文件系统。工作区里有
     * {@code docs -> /别处} 这样一个<b>目录</b>软链时，{@code root/docs/secret.md}
     * 在字符串上完全合法，{@code startsWith(root)} 通过；而只检查最后一段是不是软链
     * 的话，{@code secret.md} 是个真文件，也通过。整条守卫就被一个中间目录绕过去了。
     * {@code node_modules/.bin}、{@code docs -> ../shared} 这类软链在真实项目里很常见。
     *
     * <h2>文件还不存在时怎么办（写入要用）</h2>
     *
     * <p>{@code toRealPath()} 要求路径存在。新建文件时它不存在，所以这里往上找到
     * <b>最近一个存在的祖先</b>去 realpath，再把剩下的名字接回去 —— 软链只可能出现在
     * 已经存在的那些段上，还不存在的段不可能是软链。
     */
    private boolean containedAfterSymlinks(Path candidate) {
        Path existing = candidate;
        int climbed = 0;
        while (existing != null && !Files.exists(existing, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
            existing = existing.getParent();
            climbed++;
        }
        if (existing == null) {
            return false;       // 一路到根都不存在：不可能在工作区里
        }
        Path real = realPathOf(existing);
        if (climbed == 0) {
            return real.startsWith(root);
        }
        // 把爬上去的那几段接回来（它们还不存在，所以不可能是软链）。
        // subpath(n, n) 会抛 IllegalArgumentException，所以这一步必须在 climbed>0 之后算 ——
        // 放在三元判断前面求值的话，每一次正常读取都会炸。
        Path tail = candidate.subpath(candidate.getNameCount() - climbed, candidate.getNameCount());
        return real.resolve(tail).normalize().startsWith(root);
    }

    /** realpath，取不到就退回 normalize 后的绝对路径 —— 取不到时后面的检查照常挡。 */
    private static Path realPathOf(Path path) {
        try {
            return path.toRealPath();
        } catch (IOException e) {
            return path.toAbsolutePath().normalize();
        }
    }

/**
     * 写入目标的解析。与 {@link #resolveReadable} 的差别只在「存在性」这一条上。
     *
     * <h2>目标可以还不存在，但上级目录必须存在</h2>
     *
     * <p>新建文件是正当需求，所以不要求目标已存在。但<b>不替用户建目录</b>：
     * 模型写错一个路径（{@code src/mian/java/Foo.java}）时，自动建目录会静默造出
     * 一棵没人要的目录树，而用户以为自己确认的是「改一个文件」。
     * 宁可报错说上级目录不存在，让他自己看一眼。
     *
     * <h2>目标存在时的三条要求和读一样</h2>
     *
     * <p>不能是软链（跟随写入会改到工作区外的文件）、不能是目录、扩展名要在白名单里。
     * 白名单在写这一侧尤其要紧：它挡住的是「把内容覆盖进 .env / id_rsa」。
     *
     * <p>大小上限不在这里查 —— 这里没有内容。由 {@code WorkspaceService.write} 查。
     */
    public Resolution resolveWritable(String relativePath) {
        if (relativePath == null || relativePath.isBlank()) {
            return Resolution.denied(Reason.EMPTY);
        }
        Path candidate;
        try {
            Path given = Paths.get(relativePath.trim());
            if (given.isAbsolute()) {
                return Resolution.denied(Reason.OUTSIDE_ROOT);
            }
            candidate = root.resolve(given).normalize();
        } catch (Exception e) {
            return Resolution.denied(Reason.OUTSIDE_ROOT);
        }
        if (Files.isSymbolicLink(candidate)) {
            return Resolution.denied(Reason.SYMLINK);
        }
        if (!containedAfterSymlinks(candidate)) {
            return Resolution.denied(Reason.OUTSIDE_ROOT);
        }
        // 写到工作区根自己身上没有意义，而且 root 是目录 —— 单独挡掉，理由才说得清
        if (candidate.equals(root)) {
            return Resolution.denied(Reason.NOT_REGULAR_FILE);
        }
        if (Files.exists(candidate) && !Files.isRegularFile(candidate)) {
            return Resolution.denied(Reason.NOT_REGULAR_FILE);
        }
        if (!extensionAllowed(candidate)) {
            return Resolution.denied(Reason.EXTENSION_NOT_ALLOWED);
        }
        Path parent = candidate.getParent();
        if (parent == null || !Files.isDirectory(parent)) {
            return Resolution.denied(Reason.PARENT_NOT_FOUND);
        }
        return new Resolution(candidate, Reason.OK);
    }

    public boolean extensionAllowed(Path file) {
        String name = file.getFileName().toString().toLowerCase(Locale.ROOT);
        int dot = name.lastIndexOf('.');
        String key = dot >= 0 && dot < name.length() - 1 ? name.substring(dot + 1) : name;
        return allowedExtensions.contains(key);
    }
}
