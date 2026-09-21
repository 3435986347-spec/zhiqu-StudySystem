package com.zhiqu.service.workspace;

import com.zhiqu.common.BusinessException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.stream.Stream;

/**
 * 工作区的只读能力：列目录、读文件、按关键词找。
 *
 * <h2>每个入口都先问「这一档允许吗」</h2>
 *
 * <p>权限问的是 {@link WorkspaceAccess#effectiveMode()}，不是配置里写的那一档 ——
 * 三个前置条件有一条不满足时，配置说 EXEC 也只能是 OFF。
 *
 * <h2>为什么跳过隐藏目录与常见的大目录</h2>
 *
 * <p>{@code .git} / {@code node_modules} / {@code target} 里的内容对「读懂这个项目」
 * 没有帮助，却能轻易占满条数上限、把真正的源码挤出去。这不是安全考虑，是可用性考虑 ——
 * 但它同时也避免了把 {@code .git/config}（可能含带 token 的远程地址）列出来。
 */
@Service
public class WorkspaceService {
    private static final Logger log = LoggerFactory.getLogger(WorkspaceService.class);

    /** 列目录时跳过的目录名 —— 噪声大、体积大，且对理解项目没有帮助。 */
    private static final List<String> SKIPPED_DIRS = List.of(
            ".git", ".svn", ".hg", ".idea", ".vscode", "node_modules", "target", "build",
            "dist", "out", "__pycache__", ".venv", "venv", ".gradle", ".mvn");

    private final WorkspaceProperties properties;
    private final WorkspaceAccess access;
    private final WorkspaceGuard guard;

    public WorkspaceService(WorkspaceProperties properties,
                            @Value("${server.address:}") String serverAddress) {
        this.properties = properties;
        this.access = new WorkspaceAccess(properties, serverAddress);
        this.guard = access.enabled()
                ? new WorkspaceGuard(access.root(), properties.getAllowedExtensions(), properties.getMaxFileBytes())
                : null;
        if (access.refusalReason() != null) {
            // 降级必须说出来。静默关掉才是最糟的那种：用户会一直以为它开着。
            log.warn("工作区未启用：{}", access.refusalReason());
        } else if (access.enabled()) {
            log.info("工作区已启用：mode={} root={}", access.effectiveMode(), access.root());
        }
    }

    public WorkspaceAccess access() {
        return access;
    }

    /** 一个文件在列表里的样子。{@code path} 永远是相对工作区根的。 */
    public record Entry(String path, boolean directory, long size, boolean readable) {
    }

    private void requireRead() {
        if (!access.effectiveMode().allowsRead()) {
            throw new BusinessException(access.refusalReason() != null
                    ? access.refusalReason()
                    : "工作区未启用（app.workspace.mode 默认为 OFF）");
        }
    }

    /**
     * 列出某个目录下的条目（不递归）。
     *
     * @param relativeDir 相对工作区根的目录；空表示根本身
     */
    public List<Entry> list(String relativeDir) {
        requireRead();
        WorkspaceGuard.Resolution dir = guard.resolveDirectory(relativeDir);
        if (!dir.ok()) {
            throw new BusinessException(describe(dir.reason(), relativeDir));
        }
        List<Entry> entries = new ArrayList<>();
        try (Stream<Path> children = Files.list(dir.path())) {
            List<Path> sorted = children
                    .filter(p -> !skipped(p))
                    .sorted(Comparator.comparing((Path p) -> !Files.isDirectory(p))
                            .thenComparing(p -> p.getFileName().toString().toLowerCase(Locale.ROOT)))
                    .limit(properties.getMaxEntries())
                    .toList();
            for (Path child : sorted) {
                boolean directory = Files.isDirectory(child);
                long size = directory ? 0L : sizeOf(child);
                entries.add(new Entry(
                        access.root().relativize(child).toString(),
                        directory,
                        size,
                        // 目录不谈「可读」；文件的可读性由守卫说了算，列表里先告诉用户，
                        // 免得他点开一个 .env 才被拒绝
                        !directory && guard.extensionAllowed(child) && size <= properties.getMaxFileBytes()));
            }
        } catch (IOException | UncheckedIOException e) {
            throw new BusinessException("读取目录失败：" + e.getMessage());
        }
        return entries;
    }

    /** 读一个文件的全文。 */
    public String read(String relativePath) {
        requireRead();
        WorkspaceGuard.Resolution file = guard.resolveReadable(relativePath);
        if (!file.ok()) {
            throw new BusinessException(describe(file.reason(), relativePath));
        }
        try {
            return Files.readString(file.path(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            // 二进制文件按 UTF-8 读会抛 MalformedInput；这不是故障，是「这个文件不该读」
            throw new BusinessException("这个文件不是 UTF-8 文本，读不了：" + relativePath);
        }
    }


    /** 一条搜索命中。{@code line} 从 1 开始，{@code text} 可能被截断过。 */
    public record Hit(String path, int line, String text) {
    }

    /**
     * 在工作区里按关键词找 —— <b>字面量匹配，大小写不敏感，不接受正则</b>。
     *
     * <h2>为什么不让调用方给正则</h2>
     *
     * <p>这个入口的调用方是模型。一个像 {@code (a+)+b} 这样的正则在不匹配时会灾难性回溯，
     * 在我们自己的 JVM 上把一个核心跑满几分钟 —— 这是一次拿我们自己的进程当靶子的 DoS，
     * 而且是模型「好心」写出来的，没有恶意也会发生。字面量匹配少一点表达力，
     * 换掉的是一整类不需要存在的故障。
     *
     * <h2>三道上限各挡一件不同的事</h2>
     *
     * <ul>
     *   <li>{@code maxSearchFiles} —— 挡「根目录指错了」（比如指到家目录）把进程拖死</li>
     *   <li>{@code maxSearchHits} —— 挡搜一个常见词（{@code the}）把模型上下文塞满</li>
     *   <li>{@code maxSearchLineChars} —— 挡压缩过的 .js 单行几十万字符</li>
     * </ul>
     *
     * <p>命中条数到顶就<b>停下</b>并在返回里说清楚（调用方看得到 {@code truncated}），
     * 而不是悄悄少给几条 —— 「找到 80 条」和「至少 80 条，没找完」是两件事。
     *
     * @param relativeDir 搜索起点，相对工作区根；空表示整个工作区
     */
    public SearchResult search(String query, String relativeDir) {
        requireRead();
        String needle = query == null ? "" : query.trim();
        if (needle.isEmpty()) {
            throw new BusinessException("要搜什么？关键词不能为空");
        }
        WorkspaceGuard.Resolution dir = guard.resolveDirectory(relativeDir);
        if (!dir.ok()) {
            throw new BusinessException(describe(dir.reason(), relativeDir));
        }

        String lower = needle.toLowerCase(Locale.ROOT);
        List<Hit> hits = new ArrayList<>();
        int visited = 0;
        boolean truncated = false;

        try (Stream<Path> walk = Files.walk(dir.path())) {
            for (Path file : walk.sorted().toList()) {
                // 多收一条再判：hits 到了 max+1 才说明「还有更多」。
                // 用 >= max 的话，正好 max 条（已经找全了）会被误报成截断。
                if (hits.size() > properties.getMaxSearchHits()) {
                    truncated = true;
                    break;
                }
                if (visited >= properties.getMaxSearchFiles()) {
                    truncated = true;
                    break;
                }
                if (Files.isDirectory(file) || underSkippedDir(file)) {
                    continue;
                }
                // 和列目录同一套可读性判定：扩展名不在清单里、或者太大，就不看。
                // 这不只是性能 —— 它保证 .env / .pem 不会因为「搜索」这条路径被读出来。
                if (!guard.extensionAllowed(file) || sizeOf(file) > properties.getMaxFileBytes()) {
                    continue;
                }
                visited++;
                collectHits(file, lower, hits);
            }
        } catch (IOException | UncheckedIOException e) {
            throw new BusinessException("搜索失败：" + e.getMessage());
        }
        // 撞上限发生在<b>最后一个文件</b>上时，循环没有下一轮去设 truncated —— 这里收口。
        // 这一段原本永远不会触发（收集时就卡死在 max 条，size 不可能 > max），
        // 于是「最后一个文件上截断」会被报成「找全了」，而模型据此得出的结论是错的。
        if (hits.size() > properties.getMaxSearchHits()) {
            hits = new ArrayList<>(hits.subList(0, properties.getMaxSearchHits()));
            truncated = true;
        }
        return new SearchResult(hits, visited, truncated);
    }

    /** 搜索结果。{@code truncated} 为真表示「还有，只是没接着找」。 */
    public record SearchResult(List<Hit> hits, int filesScanned, boolean truncated) {
    }

    private void collectHits(Path file, String lowerNeedle, List<Hit> hits) {
        List<String> lines;
        try {
            lines = Files.readAllLines(file, StandardCharsets.UTF_8);
        } catch (IOException | UncheckedIOException e) {
            // 不是 UTF-8 文本（二进制混进了白名单扩展名）。跳过，不让一个文件毁掉整次搜索。
            return;
        }
        // 收到 max+1 条为止 —— 那一条不返回给调用方，只用来判断「是不是还有」。
        for (int i = 0; i < lines.size() && hits.size() <= properties.getMaxSearchHits(); i++) {
            String line = lines.get(i);
            if (!line.toLowerCase(Locale.ROOT).contains(lowerNeedle)) {
                continue;
            }
            String text = line.strip();
            int cap = properties.getMaxSearchLineChars();
            if (text.length() > cap) {
                text = text.substring(0, cap) + "…（本行过长，已截断）";
            }
            hits.add(new Hit(access.root().relativize(file).toString(), i + 1, text));
        }
    }

    /** 这个文件所在的路径上有没有噪声目录 —— Files.walk 是递归的，得逐级看。 */
    private boolean underSkippedDir(Path file) {
        Path relative = access.root().relativize(file);
        for (Path part : relative) {
            if (SKIPPED_DIRS.contains(part.toString().toLowerCase(Locale.ROOT))) {
                return true;
            }
        }
        return false;
    }

    private boolean skipped(Path path) {
        String name = path.getFileName().toString();
        return Files.isDirectory(path) && SKIPPED_DIRS.contains(name.toLowerCase(Locale.ROOT));
    }

    private long sizeOf(Path path) {
        try {
            return Files.size(path);
        } catch (IOException e) {
            return -1L;
        }
    }

    /** 把拒绝理由翻译成人话 —— 六种原因是六件不同的事，不能都说「读不到」。 */
    private String describe(WorkspaceGuard.Reason reason, String path) {
        return switch (reason) {
            case EMPTY -> "没有给出路径";
            case OUTSIDE_ROOT -> "路径超出了工作区范围（只接受相对路径，且不能用 ../ 跳出去）：" + path;
            case SYMLINK -> "这是一个符号链接，工作区不跟随链接：" + path;
            case NOT_REGULAR_FILE -> "不是一个可读的普通文件（可能不存在，或者是目录）：" + path;
            case EXTENSION_NOT_ALLOWED -> "这个类型的文件不在允许清单里（避免把密钥、证书这类内容读进上下文）：" + path;
            case TOO_LARGE -> "文件超过了 " + properties.getMaxFileBytes() + " 字节的上限：" + path;
            case OK -> "";
        };
    }
}
