package com.zhiqu.service.workspace;

import com.zhiqu.common.BusinessException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
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
    private final WorkspaceSettingsStore settingsStore;
    private final String serverAddress;

    // volatile 而非 final：档位 / 根目录现在能在运行时被管理员从界面切换（applySettings）。
    // access 与 guard 成对重建、成对替换，读的一方各自读一次 volatile 即可。切换是偶发的
    // 单管理员操作，不用把这两个读打包成一个快照 —— 最坏的竞态是一次在途请求用了旧 root，
    // 而它下一道守卫检查会把不属于旧 root 的路径拒掉，不会漏。
    private volatile WorkspaceAccess access;
    private volatile WorkspaceGuard guard;

    /**
     * 测试便利构造器：不接持久化 store，用一个指向临时目录、<b>不会命中 ~/.zhiqu 里已有文件</b>
     * 的一次性 store。既让既有的 25 处测试原样编译，又保证它们读到的不是你真实的持久化设置。
     * 生产走下面那个三参构造器（Spring 注入 store）。
     */
    WorkspaceService(WorkspaceProperties properties,
                     @Value("${server.address:}") String serverAddress) {
        this(properties,
                new WorkspaceSettingsStore(
                        System.getProperty("java.io.tmpdir", ".") + "/zhiqu-ws-ephemeral-"
                                + java.util.UUID.randomUUID() + ".json",
                        new com.fasterxml.jackson.databind.ObjectMapper()),
                serverAddress);
    }

    @org.springframework.beans.factory.annotation.Autowired
    public WorkspaceService(WorkspaceProperties properties,
                            WorkspaceSettingsStore settingsStore,
                            @Value("${server.address:}") String serverAddress) {
        this.properties = properties;
        this.settingsStore = settingsStore;
        this.serverAddress = serverAddress;

        // 用户在界面上选过的档位 / 根目录，盖过配置里的默认值 —— 否则桌面每次重启都回到 OFF。
        // 但这只是「想要什么」；「实际允许什么」仍由 rebuild 里的三条前提裁决。
        WorkspaceMode mode = properties.resolvedMode();
        String root = properties.getRoot();
        var saved = settingsStore.load();
        if (saved.isPresent()) {
            if (saved.get().mode() != null && !saved.get().mode().isBlank()) {
                mode = WorkspaceMode.parse(saved.get().mode());
            }
            if (saved.get().root() != null) {
                root = saved.get().root();
            }
        }
        rebuild(mode, root);

        if (access.refusalReason() != null) {
            // 降级必须说出来。静默关掉才是最糟的那种：用户会一直以为它开着。
            log.warn("工作区未启用：{}", access.refusalReason());
        } else if (access.enabled()) {
            log.info("工作区已启用：mode={} root={}", access.effectiveMode(), access.root());
        }
    }

    /**
     * 按给定档位 + 根目录重建 access 与 guard。<b>三条前提（回环 / 目录存在 / 档位≠OFF）
     * 在这里原样重跑</b> —— 所以运行时把档位切到 EXEC，在公网（非回环）上重建出来仍是 OFF。
     * 这条不变量由 {@code WorkspaceRuntimeToggleTest} 钉住。
     */
    private synchronized void rebuild(WorkspaceMode mode, String root) {
        WorkspaceAccess next = new WorkspaceAccess(mode, root, serverAddress);
        this.access = next;
        this.guard = next.enabled()
                ? new WorkspaceGuard(next.root(), properties.getAllowedExtensions(), properties.getMaxFileBytes())
                : null;
    }

    /**
     * 管理员从界面切换档位 / 根目录。持久化用户的选择，并立即生效（或按前提降级）。
     *
     * @return 切换后<b>实际</b>的访问状态（可能因为前提不满足而仍是 OFF，此时 refusalReason 说明原因）
     */
    public synchronized WorkspaceAccess applySettings(String modeRaw, String root) throws java.io.IOException {
        WorkspaceMode mode = WorkspaceMode.parse(modeRaw);   // 认不出的档位一律回落 OFF
        String trimmedRoot = root == null ? "" : root.trim();
        rebuild(mode, trimmedRoot);
        // 存的是「想要什么」（用户选的原始档位），不是降级后的结果 —— 换台机器 / 补上回环后，
        // 用户原本想要的档位应当自动恢复，而不是被这次的降级结果永久固化成 OFF。
        settingsStore.save(new WorkspaceSettingsStore.Settings(mode.name(), trimmedRoot));
        return access;
    }

    /** 用户当前选定的档位 / 根目录（持久化的那一份，不是降级结果）。 */
    public WorkspaceSettingsStore.Settings currentSelection() {
        return settingsStore.load().orElseGet(
                () -> new WorkspaceSettingsStore.Settings(properties.resolvedMode().name(), properties.getRoot()));
    }

    /** 服务是否绑在回环地址 —— 文件夹浏览器与档位切换都要看它（公网上一律不给）。 */
    public boolean loopbackBound() {
        return WorkspaceAccess.isLoopback(serverAddress);
    }

    public WorkspaceAccess access() {
        return access;
    }

    /** 文件夹浏览器里的一个子目录。 */
    public record DirEntry(String name, String path) {
    }

    /** 一次浏览的结果：当前目录、它的上一级、以及子目录列表。 */
    public record Browse(String path, String parent, java.util.List<DirEntry> dirs, boolean truncated) {
    }

    /** 浏览器最多列多少个子目录 —— 家目录下偶尔有极多条目，不封会把响应撑爆。 */
    private static final int MAX_BROWSE_ENTRIES = 500;

    /**
     * 列一个目录下的<b>子目录</b>，供界面上的文件夹选择器用。
     *
     * <p>它<b>独立于工作区根</b>：用户正是要用它去挑选那个根，所以必须能浏览工作区之外。
     * 因此它只列<b>目录名</b>，不列文件、更不读任何文件内容 —— 能力仅限「看见文件夹结构」。
     * 调用它的控制器端点另加两道闸：管理员 + 回环（公网上一律不给）。
     *
     * <p>不传路径时从用户主目录开始。读不动某个目录（权限）就返回空列表而不是抛异常 ——
     * 选择器点进一个没权限的目录，该是「这里是空的」，不是整个功能报错。
     */
    public Browse browseDirectories(String rawPath) {
        Path base = (rawPath == null || rawPath.isBlank())
                ? Paths.get(System.getProperty("user.home", "/"))
                : Paths.get(rawPath.trim());
        base = base.toAbsolutePath().normalize();

        java.util.List<DirEntry> dirs = new ArrayList<>();
        boolean truncated = false;
        try (java.nio.file.DirectoryStream<Path> stream =
                     Files.newDirectoryStream(base, Files::isDirectory)) {
            for (Path child : stream) {
                if (dirs.size() >= MAX_BROWSE_ENTRIES) {
                    truncated = true;   // 说出来 —— 「500 个」和「至少 500 个」是两回事
                    break;
                }
                Path name = child.getFileName();
                if (name != null) {
                    dirs.add(new DirEntry(name.toString(), child.toString()));
                }
            }
        } catch (IOException | RuntimeException ignored) {
            // 权限不足 / 目录不存在：返回空，不抛 —— 选择器里表现为「这个目录是空的」
        }
        dirs.sort(java.util.Comparator.comparing(d -> d.name().toLowerCase(java.util.Locale.ROOT)));
        Path parent = base.getParent();
        return new Browse(base.toString(), parent == null ? null : parent.toString(), dirs, truncated);
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
    /**
     * 一次列目录的结果。{@code truncated} 为真表示<b>还有条目没列出来</b>。
     *
     * <p>与搜索那边同一条纪律：截断必须说出来。列目录原来只是 {@code .limit(maxEntries)}
     * 静默截断 —— 一个有 600 个文件的目录返回 500 条，模型据此说「这个目录有 500 个文件」，
     * 而那是错的。
     */
    public record Listing(List<Entry> entries, boolean truncated) {
    }

    /** 兼容旧调用：只要条目。需要知道有没有截断就用 {@link #listing}。 */
    public List<Entry> list(String relativeDir) {
        return listing(relativeDir).entries();
    }

    public Listing listing(String relativeDir) {
        requireRead();
        WorkspaceGuard.Resolution dir = guard.resolveDirectory(relativeDir);
        if (!dir.ok()) {
            throw new BusinessException(describe(dir.reason(), relativeDir));
        }
        List<Entry> entries = new ArrayList<>();
        boolean truncated = false;
        try (Stream<Path> children = Files.list(dir.path())) {
            // 多取一条：拿到 max+1 说明还有没列出来的。正好 max 条时不该报截断。
            List<Path> sorted = children
                    .filter(p -> !skipped(p))
                    .sorted(Comparator.comparing((Path p) -> !Files.isDirectory(p))
                            .thenComparing(p -> p.getFileName().toString().toLowerCase(Locale.ROOT)))
                    .limit(properties.getMaxEntries() + 1L)
                    .toList();
            if (sorted.size() > properties.getMaxEntries()) {
                sorted = sorted.subList(0, properties.getMaxEntries());
                truncated = true;
            }
            for (Path child : sorted) {
                boolean directory = Files.isDirectory(child);
                long size = directory ? 0L : sizeOf(child);
                entries.add(new Entry(
                        relative(child),
                        directory,
                        size,
                        // 目录不谈「可读」；文件的可读性由守卫说了算，列表里先告诉用户，
                        // 免得他点开一个 .env 才被拒绝
                        !directory && guard.extensionAllowed(child) && size <= properties.getMaxFileBytes()));
            }
        } catch (IOException | UncheckedIOException e) {
            throw new BusinessException("读取目录失败：" + e.getMessage());
        }
        return new Listing(entries, truncated);
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
            hits.add(new Hit(relative(file), i + 1, text));
        }
    }

    /** 这个文件所在的路径上有没有噪声目录 —— Files.walk 是递归的，得逐级看。 */
    private boolean underSkippedDir(Path file) {
        for (Path part : guard.root().relativize(file)) {
            if (SKIPPED_DIRS.contains(part.toString().toLowerCase(Locale.ROOT))) {
                return true;
            }
        }
        return false;
    }

/**
     * 把绝对路径换算成相对工作区根的路径。
     *
     * <p>基准必须是<b>守卫那份 realpath 过的 root</b>，不是配置里写的那个：
     * 守卫解析出来的候选路径已经解开了软链，拿没解开的 root 去 relativize，
     * 结果会是一串 {@code ../../..}。macOS 上这不是边角情况 ——
     * {@code /tmp} 与 {@code /var} 本身就是软链，测试用的临时目录一律中招。
     */
    private String relative(Path absolute) {
        return guard.root().relativize(absolute).toString();
    }

    /**
     * 只校验「这个路径能不能写」，不碰内容、不碰磁盘。
     *
     * <p>给工具调用当场用：路径不合法时立刻把理由回给模型，它才能如实转述并改用别的路径；
     * 攒到用户点确认时才报错，用户面对的是一个莫名其妙失败的确认框。
     */
    public void checkWritable(String relativePath) {
        if (!access.effectiveMode().allowsWrite()) {
            throw new BusinessException(access.refusalReason() != null
                    ? access.refusalReason()
                    : "工作区当前是只读的（app.workspace.mode 需要 WRITE 或更高）");
        }
        WorkspaceGuard.Resolution file = guard.resolveWritable(relativePath);
        if (!file.ok()) {
            throw new BusinessException(describe(file.reason(), relativePath));
        }
    }

/** 文件还不存在时的基线取值 —— 用一个明确的标记，而不是 null。 */
    public static final String ABSENT = "ABSENT";

    /**
     * 一个文件当前内容的基线指纹。不存在返回 {@link #ABSENT}。
     *
     * <p>用 SHA-256 而不是 {@code String.hashCode()}：后者是 32 位、可轻易构造碰撞，
     * 而这个值要用来判断「这个文件从 agent 读过之后有没有被改」。
     */
    public String baselineOf(String relativePath) {
        requireRead();
        WorkspaceGuard.Resolution file = guard.resolveWritable(relativePath);
        if (!file.ok()) {
            throw new BusinessException(describe(file.reason(), relativePath));
        }
        return hashOf(file.path());
    }

    private static String hashOf(Path path) {
        if (!Files.isRegularFile(path)) {
            return ABSENT;
        }
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] sum = digest.digest(Files.readAllBytes(path));
            StringBuilder hex = new StringBuilder(sum.length * 2);
            for (byte b : sum) {
                hex.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
            }
            return hex.toString();
        } catch (IOException | NoSuchAlgorithmException e) {
            throw new BusinessException("读不到文件用于校验：" + path.getFileName());
        }
    }

    /**
     * 写一个文件 —— <b>只有用户确认草稿时才会走到这里</b>，模型的工具调用不会。
     *
     * <h2>基线校验：为什么不能省</h2>
     *
     * <p>{@code expectedBaseline} 是 agent <b>读到这个文件时</b>它内容的指纹，由草稿记下来。
     * 从那一刻到用户点确认，中间可能隔着几分钟 —— 这段时间里用户完全可能在自己的编辑器里
     * 改了同一个文件。不校验的话，一个基于旧内容生成的改动会把新内容整份覆盖掉，
     * 而用户以为自己确认的只是「应用刚才那个建议」。这和知识 Wiki 的
     * {@code base_content_hash} 是同一条纪律，理由也一样。
     *
     * <p>文件在 agent 读的时候还不存在，基线就是 {@link #ABSENT}；确认时它已经被别人建出来了，
     * 同样要拒绝 —— 「新建」和「覆盖」是两件事。
     *
     * <h2>先写临时文件再原子改名</h2>
     *
     * <p>直接往目标文件写，中途失败（磁盘满、进程被杀）会留下一个被截断的文件 ——
     * 那是把用户的源码毁掉，比不写严重得多。
     */
/** 一个待写入的文件。{@code baseline} 是 agent 读到它时的内容指纹。 */
    public record PendingWrite(String path, String content, String baseline) {
    }

    /**
     * 成批写入：<b>先把每个文件都校验一遍，全部通过了再逐个写</b>。
     *
     * <h2>为什么不能边校验边写</h2>
     *
     * <p>逐个「校验并写」的话，第三个文件基线不符时前两个已经落盘了。用户看到一条报错，
     * 却不知道自己的工作目录已经被改了一半 —— 而那一半属于一个他并没有完整确认的方案。
     * 回滚也无从谈起：旧内容已经被覆盖掉了。
     *
     * <h2>这不是事务，说清楚边界</h2>
     *
     * <p>写到第二个文件时磁盘满、进程被杀，仍然会留下半批。这里消掉的是唯一一种
     * <b>可预见</b>的半批 —— 基线不符与路径非法，而那正是实际最常发生的两种。
     * 真事务要写日志和回滚，代价远超它能挡住的风险。
     */
    public void writeAll(List<PendingWrite> files) {
        if (files == null || files.isEmpty()) {
            throw new BusinessException("没有要写入的文件");
        }
        for (PendingWrite file : files) {
            checkWritable(file.path());
            checkBaseline(file.path(), file.baseline());
        }
        for (PendingWrite file : files) {
            write(file.path(), file.content(), file.baseline());
        }
    }

    /** 写这个文件要新建的目录（相对工作区根）。草稿记下它，确认框里说出来 —— 建目录不能是静默的。 */
    public List<String> newDirectoriesFor(String relativePath) {
        return guard == null ? List.of() : guard.missingParents(relativePath);
    }

    /** 基线校验单独一份，成批写入要在动手之前先问一遍，单个写入要在写之前问一遍。 */
    private void checkBaseline(String relativePath, String expectedBaseline) {
        if (expectedBaseline == null || expectedBaseline.isBlank()) {
            throw new BusinessException("这份草稿没有记下基线，不能确认写入：" + relativePath);
        }
        WorkspaceGuard.Resolution file = guard.resolveWritable(relativePath);
        if (!file.ok()) {
            throw new BusinessException(describe(file.reason(), relativePath));
        }
        String actual = hashOf(file.path());
        if (!expectedBaseline.equals(actual)) {
            throw new BusinessException(ABSENT.equals(expectedBaseline)
                    ? "生成这份草稿时 " + relativePath + " 还不存在，现在它已经存在了 —— 请重新生成"
                    : ABSENT.equals(actual)
                            ? relativePath + " 已经被删除，这份草稿不能再应用"
                            : relativePath + " 在生成草稿之后被改过了，不能用旧内容覆盖 —— 请重新生成");
        }
    }

    public void write(String relativePath, String content, String expectedBaseline) {
        if (!access.effectiveMode().allowsWrite()) {
            throw new BusinessException(access.refusalReason() != null
                    ? access.refusalReason()
                    : "工作区当前是只读的（app.workspace.mode 需要 WRITE 或更高）");
        }
        String body = content == null ? "" : content;
        WorkspaceGuard.Resolution file = guard.resolveWritable(relativePath);
        if (!file.ok()) {
            throw new BusinessException(describe(file.reason(), relativePath));
        }
        if (body.getBytes(StandardCharsets.UTF_8).length > properties.getMaxFileBytes()) {
            throw new BusinessException("要写入的内容超过了 " + properties.getMaxFileBytes() + " 字节的上限");
        }
        checkBaseline(relativePath, expectedBaseline);
        Path tmp = file.path().resolveSibling(file.path().getFileName() + ".zhiqu-tmp");
        try {
            // 上级目录不存在就建出来（草稿里已经列出了会建哪些，用户确认的就是这个）
            Files.createDirectories(file.path().getParent());
            Files.writeString(tmp, body, StandardCharsets.UTF_8);
            try {
                Files.move(tmp, file.path(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException e) {
                // 少数文件系统不支持原子改名。退回普通改名：仍然比就地写安全
                Files.move(tmp, file.path(), StandardCopyOption.REPLACE_EXISTING);
            }
            log.info("工作区写入：{}（{} 字节）", relativePath, body.length());
        } catch (IOException e) {
            throw new BusinessException("写入失败：" + e.getMessage());
        } finally {
            try {
                Files.deleteIfExists(tmp);
            } catch (IOException ignored) {
                // 临时文件残留不影响正确性，不值得把一次成功的写入变成失败
            }
        }
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
            case PARENT_NOT_FOUND -> "上级路径被一个文件占着，没法在它下面建文件：" + path;
            case OK -> "";
        };
    }
}
