package com.zhiqu.service.workspace;

import com.zhiqu.common.BusinessException;
import com.zhiqu.common.DeploymentProfiles;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;

/**
 * 在工作区里跑一条命令。<b>默认关闭，只在本机开发时开。</b>
 *
 * <h2>先说清楚这个「沙箱」不是什么</h2>
 *
 * <p>白名单里有 {@code python3} / {@code node} / {@code java}，而<b>允许它们就等于允许任意代码</b>：
 * 一段 Python 能删掉用户的家目录，这一层拦不住，进程级隔离（容器 / seccomp）不在这里。
 * 把它叫「沙箱」而不说明这一点，会让人以为代码被关住了 —— 没有。
 *
 * <p>所以真正的边界不是「限制代码能做什么」，而是<b>只能跑用户已经看过的代码</b>：
 *
 * <ul>
 *   <li>禁掉 {@code -c} / {@code -e} / {@code --eval} 这类<b>行内代码</b>开关。
 *       有了它们，模型可以把任意程序当成一个参数传进来，那段代码没有经过任何人的眼睛。
 *       禁掉之后，执行对象只能是工作区里<b>已经存在的文件</b> —— 那些文件要么是用户自己写的，
 *       要么走过 {@code CODE_DRAFT} 的 diff 确认。</li>
 *   <li>参数里不接受绝对路径与 {@code ..}：命令的作用范围跟着工作区走。</li>
 *   <li>不接受任意 shell 字符串，只接受「命令名 + 参数数组」。接受 shell 字符串等于把管道、
 *       重定向、{@code rm -rf} 一起放进来，而且 {@code allowedCommands} 里一旦有 sh/bash，
 *       白名单本身就等于没有（{@code WorkspaceModeTest} 钉着这一条）。</li>
 * </ul>
 *
 * <h2>剩下的约束是「炸了也炸不大」，不是「炸不了」</h2>
 *
 * <ul>
 *   <li><b>超时</b> —— 到点 {@code destroyForcibly}。死循环不会把这台机器占住。</li>
 *   <li><b>输出上限</b> —— stdout + stderr 合计截断并<b>明确标注</b>。一个 {@code while True: print()}
 *       能在几秒里产出几百 MB，原样收进内存就是 OOM，原样喂给模型就是把上下文冲光。</li>
 *   <li><b>工作目录</b>在工作区内。</li>
 *   <li><b>不继承父进程环境变量</b> —— 这条最容易漏。主进程里有
 *       {@code ZHIQU_SYSTEM_AI_API_KEY}、数据库密码、{@code ZHIQU_WEB_SEARCH_API_KEY}；
 *       默认继承的话，用户让 AI「跑一下这个脚本」，脚本里一句 {@code os.environ} 就把它们全拿走了，
 *       而输出会原样回到模型上下文里。</li>
 * </ul>
 *
 * <p>环境清空之后子进程就没有 {@code PATH} 了，所以命令名在<b>父进程</b>这一侧解析成绝对路径，
 * 再交给子进程 —— 解析用父进程的 PATH，但那份 PATH 不会传下去。
 */
@Service
public class WorkspaceExecutor {
    private static final Logger log = LoggerFactory.getLogger(WorkspaceExecutor.class);

    /**
     * 行内代码开关。带上它们，命令行本身就是一段程序。
     *
     * <p>这是这一层<b>唯一</b>真正意义上的安全判定：禁掉之后能跑的只有工作区里已经存在的文件，
     * 而那些文件用户看过。留着的话，{@code python3 -c "..."} 里的内容没有经过任何确认。
     */
    private static final Set<String> INLINE_CODE_FLAGS = Set.of(
            "-c", "-e", "--eval", "--command", "--exec", "-command", "--execute",
            "-E", "--expression", "-i", "--interactive", "--print", "--call");

    /**
     * 各解释器自己的「行内代码」短参数（会被合写，如 {@code node -pe}、{@code python3 -Bc}）。
     * 不能对所有命令一刀切：{@code go build -p 4} 的 -p 是并行度，{@code java -cp} 是类路径。
     */
    private static final Map<String, String> INLINE_SHORT_LETTERS = Map.of(
            "node", "epi",
            "python", "ci",
            "python3", "ci");

    /** npm 这几个子命令会下载并运行别人的包 —— 用户没看过的代码。 */
    private static final Set<String> NPM_REMOTE_SUBCOMMANDS = Set.of("exec", "x", "create", "init", "dlx");

    private final WorkspaceProperties properties;
    // 不存档位和路径守卫：管理员能从界面切（WorkspaceService.applySettings）。原来这里启动时存一份，
    // 以 EXEC 起的后端切到只读还能跑命令、换了项目命令还跑在旧目录（第一百零九轮才发现）
    private final WorkspaceService workspaceService;
    private final boolean productionProfile;

    public WorkspaceExecutor(WorkspaceProperties properties,
                             WorkspaceService workspaceService,
                             @Value("${spring.profiles.active:}") String activeProfiles) {
        this.properties = properties;
        this.workspaceService = workspaceService;
        this.productionProfile = isProduction(activeProfiles);
        if (this.productionProfile && access().effectiveMode().allowsExec()) {
            log.warn("生产 profile 下不允许执行命令，app.workspace.mode=EXEC 的执行能力已禁用");
        }
    }

    /**
     * 逗号分隔的 profile 列表里有没有生产。
     *
     * <p>判定本身住在 {@link DeploymentProfiles} —— 这里保留一个委托，
     * 是因为 {@code WorkspaceExecutorTest} 的一批判据直接调它。
     */
    static boolean isProduction(String activeProfiles) {
        return DeploymentProfiles.isProduction(activeProfiles);
    }

    /**
     * 子进程的 HOME：自己的一个空目录（第九十五轮），建一次、只给本用户读写。原来是工作区本身 ——
     * macOS 的 python3 把缓存写进了用户项目里的 {@code Library/Caches/com.apple.python}（网页代码模式的真浏览器测试里看到的）；
     * 仓库里带的 {@code .local/lib/python3.x/site-packages/sitecustomize.py} 会被任何一句 python3 执行
     * （命令行第九十轮修过同一个口子，那时这边没跟上）。
     */
    private volatile Path childHome;

    private Path childHome() throws IOException {
        Path home = childHome;
        if (home != null && Files.isDirectory(home)) {
            return home;
        }
        synchronized (this) {
            if (childHome == null || !Files.isDirectory(childHome)) {
                Path created = Files.createTempDirectory("zhiqu-exec-home-");
                try {
                    Files.setPosixFilePermissions(created, java.nio.file.attribute.PosixFilePermissions.fromString("rwx------"));
                } catch (UnsupportedOperationException ignored) {
                    // Windows：没有 POSIX 权限，临时目录本来就在用户自己的目录下
                }
                childHome = created;
            }
            return childHome;
        }
    }

    private WorkspaceAccess access() {
        return workspaceService.access();
    }

    /** 执行能不能用 —— 档位允许执行，且不是生产 profile。 */
    public boolean enabled() {
        return access().effectiveMode().allowsExec() && !productionProfile;
    }

    /** 当前不能执行的原因；能执行时返回 null。 */
    public String refusalReason() {
        if (productionProfile) {
            return "生产环境下不允许执行命令";
        }
        if (!access().effectiveMode().allowsExec()) {
            return access().refusalReason() != null
                    ? access().refusalReason()
                    : "工作区当前不允许执行命令（app.workspace.mode 需要 EXEC）";
        }
        return null;
    }

    /**
     * 一次执行的结果。
     *
     * @param output    stdout 与 stderr 合流后的文本，可能被截断
     * @param truncated 输出是否被截断 —— 必须如实告诉调用方，否则模型会把半截输出当成全部
     * @param timedOut  是否因为超时被强杀
     */
    public record ExecResult(String command, List<String> args, int exitCode,
                             String output, boolean truncated, boolean timedOut, long millis) {
    }

    /**
     * 跑一条命令。
     *
     * @param relativeDir 工作目录，相对工作区根；空表示根本身
     */
    public ExecResult exec(String command, List<String> args, String relativeDir) {
        String refusal = refusalReason();
        if (refusal != null) {
            throw new BusinessException(refusal);
        }
        String name = command == null ? "" : command.trim();
        List<String> safeArgs = args == null ? List.of() : args;
        Check check = check(properties.getAllowedCommands(), name, safeArgs);
        switch (check.refusal()) {
            case OK -> { }
            case EMPTY -> throw new BusinessException("没有给出要执行的命令");
            case COMMAND_NOT_ALLOWED -> throw new BusinessException("命令不在允许清单里：" + name
                    + "（允许的是 " + String.join("、", properties.getAllowedCommands()) + "）");
            case NULL_ARG -> throw new BusinessException("参数里有空值");
            case INLINE_CODE -> throw new BusinessException("不接受行内代码参数 " + check.arg()
                    + " —— 只能执行工作区里已经存在的文件，那样用户才看得到要跑的是什么");
            case REMOTE_CODE -> throw new BusinessException("不接受 npm " + check.arg()
                    + " —— 它会下载并运行别人的包，那段代码用户没看过");
            case ABSOLUTE_PATH -> throw new BusinessException("参数不接受绝对路径：" + check.arg());
            case PARENT_ESCAPE -> throw new BusinessException("参数不接受跳出工作区的路径：" + check.arg());
        }

        Path dir = resolveDir(relativeDir);

        Path binary = resolveOnPath(name);
        if (binary == null) {
            throw new BusinessException("这台机器上找不到命令：" + name);
        }

        List<String> line = new ArrayList<>();
        line.add(binary.toString());
        line.addAll(safeArgs);
        return runLine(name, safeArgs, line, dir, Map.of(), properties.getExecTimeoutMs());
    }

    /**
     * shell 工具能不能用（第一百零九轮，用户：网页也要系统沙箱，和命令行一致）：只读的档位也能跑 —— 沙箱是只读的，系统挡着写。
     * 生产 profile 一律不行，这条和 {@link #enabled()} 一样不能绕。还要这台机器真有沙箱，那一条调用方问（{@code JsCodeAgent}）。
     */
    public boolean shellEnabled() {
        return access().effectiveMode().allowsRead() && !productionProfile;
    }

    /** 请沙箱实现回答「这条命令怎么起」时交过去的东西：全部由后端定，不来自子进程。 */
    public record SandboxRequest(String command, Path root, Path cwd, boolean write, String network, Path privateDir) {
    }

    /** 起进程要的东西：沙箱实现（zhiqu-cli/src/tools/sandbox.js）给的。 */
    public record Launch(String binary, List<String> args, Map<String, String> env) {
    }

    /**
     * 在系统沙箱里跑一条 shell 命令。
     *
     * @param write   能不能写工作区。这里再对一遍当前档位：跑到一半切到只读的档位，下一条命令就只读
     * @param sandbox 沙箱只有一份实现，在命令行那边；这里不再写一份
     */
    public ExecResult shell(String command, String relativeDir, boolean write, Function<SandboxRequest, Launch> sandbox) {
        if (!shellEnabled()) {
            throw new BusinessException(productionProfile ? "生产环境下不允许执行命令" : "工作区当前是关着的");
        }
        String line = command == null ? "" : command.trim();
        if (line.isEmpty()) {
            throw new BusinessException("没有给出要执行的命令");
        }
        WorkspaceAccess current = access();
        Path privateDir;
        try {
            privateDir = childHome();
        } catch (IOException e) {
            throw new BusinessException("没法准备运行环境（临时目录建不出来）：" + e.getMessage());
        }
        Path cwd = resolveDir(relativeDir);
        boolean canWrite = write && current.effectiveMode().allowsExec();
        Launch launch = sandbox.apply(new SandboxRequest(line, current.root(), cwd, canWrite, properties.getSandboxNetwork(), privateDir));
        List<String> full = new ArrayList<>();
        full.add(launch.binary());
        full.addAll(launch.args());
        return runLine(line, List.of(), full, cwd, launch.env(), properties.getShellTimeoutMs());
    }

    private Path resolveDir(String relativeDir) {
        WorkspaceGuard guard = workspaceService.guard();
        WorkspaceGuard.Resolution dir = guard == null ? null : guard.resolveDirectory(relativeDir);
        if (dir == null || !dir.ok()) {
            throw new BusinessException("工作目录不可用：" + relativeDir);
        }
        return dir.path();
    }

    /** 起进程只有这一处。extraEnv 放在最小环境上面（沙箱实现给的 PATH、临时目录这些）。 */
    private ExecResult runLine(String name, List<String> shownArgs, List<String> line, Path dir, Map<String, String> extraEnv, long timeoutMs) {
        ProcessBuilder builder = new ProcessBuilder(line)
                .directory(dir.toFile())
                .redirectErrorStream(true);
        // 主进程的环境里有 AI 密钥与数据库密码。清空之后只放回跑得起来所必需的几个，
        // 而且 PATH 给的是固定值，不是父进程那份。
        Map<String, String> env = builder.environment();
        env.clear();
        env.put("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
        try {
            env.put("HOME", childHome().toString());
        } catch (IOException e) {
            // 准备不出自己的 HOME 就不跑：退回工作区就是原来那个口子
            throw new BusinessException("没法准备运行环境（临时目录建不出来）：" + e.getMessage());
        }
        env.put("LANG", "en_US.UTF-8");
        env.putAll(extraEnv);

        long started = System.currentTimeMillis();
        Process spawned = null;
        try {
            final Process process = builder.start();
            spawned = process;

            // 读输出必须在<b>另一个线程</b>上。第一版在这里同步读，而 read() 要等到进程退出
            // 才返回 -1 —— 于是 `sleep 30` 会把读循环阻塞 30 秒，waitFor 的超时根本轮不到执行，
            // 「超时」这条约束等于不存在。判据 超时必须真的把进程杀掉 钉的就是这个。
            CappedOutput output = new CappedOutput(properties.getExecOutputLimitBytes());
            Thread reader = new Thread(() -> {
                try (InputStream in = process.getInputStream()) {
                    output.drain(in);
                } catch (IOException e) {
                    output.fail("【读取输出失败：" + e.getMessage() + "】");
                }
            }, "workspace-exec-reader");
            reader.setDaemon(true);
            reader.start();

            boolean finished = process.waitFor(timeoutMs, TimeUnit.MILLISECONDS);
            if (!finished) {
                // 整棵树一起杀：shell 里的 `sleep 100 | cat`，只杀 bash 的话下面的还在跑，还攥着管道
                process.descendants().forEach(ProcessHandle::destroyForcibly);
                process.destroyForcibly();
                process.waitFor(2, TimeUnit.SECONDS);
            }
            // 进程结束后管道才会 EOF，读线程随之收尾。给它一小段时间，超了就用已有的部分。
            reader.join(2000);
            Capture capture = output.snapshot();

            long millis = System.currentTimeMillis() - started;
            if (!finished) {
                return new ExecResult(name, shownArgs, -1,
                        capture.text() + "\n【超时：超过 " + timeoutMs + "ms，已强制结束】",
                        capture.truncated(), true, millis);
            }
            return new ExecResult(name, shownArgs, process.exitValue(),
                    capture.truncated()
                            ? capture.text() + "\n【输出超过 " + properties.getExecOutputLimitBytes() + " 字节，已截断】"
                            : capture.text(),
                    capture.truncated(), false, millis);
        } catch (IOException e) {
            throw new BusinessException("执行失败：" + e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            if (spawned != null) {
                spawned.descendants().forEach(ProcessHandle::destroyForcibly);
                spawned.destroyForcibly();
            }
            throw new BusinessException("执行被中断");
        }
    }


    /**
     * 参数校验。三条，每条挡的是不同的东西。
     */
    /** 执行前的拒绝理由。与 npm 版 zhiqu 的本地执行共用一致性用例（conformance/workspace-rules.json）。 */
    public enum Refusal { OK, EMPTY, COMMAND_NOT_ALLOWED, NULL_ARG, INLINE_CODE, REMOTE_CODE, ABSOLUTE_PATH, PARENT_ESCAPE }

    public record Check(Refusal refusal, String arg) {
    }

    /** 纯函数：命令名在不在清单里、参数合不合规矩。不碰磁盘、不起进程。 */
    public static Check check(List<String> allowedCommands, String command, List<String> args) {
        String name = command == null ? "" : command.trim();
        if (name.isEmpty()) {
            return new Check(Refusal.EMPTY, null);
        }
        if (!allowedCommands.contains(name)) {
            return new Check(Refusal.COMMAND_NOT_ALLOWED, name);
        }
        List<String> list = args == null ? List.of() : args;
        if ("npm".equals(name) && !list.isEmpty() && list.get(0) != null && NPM_REMOTE_SUBCOMMANDS.contains(list.get(0))) {
            return new Check(Refusal.REMOTE_CODE, list.get(0));
        }
        String shortLetters = INLINE_SHORT_LETTERS.getOrDefault(name, "");
        for (String arg : list) {
            if (arg == null) {
                return new Check(Refusal.NULL_ARG, null);
            }
            // 一、行内代码：这是唯一真正的安全判定，见类注释。
            // 精确匹配之外还要认 --eval=… 这种带等号的写法，以及解释器合写的短参数（node -pe、python3 -Bc）——
            // 2026-09-24 写一致性用例时发现，只做精确匹配的话这三种都能把任意代码当参数传进来。
            String flag = arg.startsWith("--") && arg.contains("=") ? arg.substring(0, arg.indexOf('=')) : arg;
            if (INLINE_CODE_FLAGS.contains(flag)) {
                return new Check(Refusal.INLINE_CODE, arg);
            }
            if (!shortLetters.isEmpty() && arg.matches("-[A-Za-z]+")
                    && arg.substring(1).chars().anyMatch(ch -> shortLetters.indexOf(ch) >= 0)) {
                return new Check(Refusal.INLINE_CODE, arg);
            }
            // 二、绝对路径：命令的作用范围要跟着工作区走
            if (arg.startsWith("/") || arg.startsWith("~")) {
                return new Check(Refusal.ABSOLUTE_PATH, arg);
            }
            // 三、往上跳：同上，而且 .. 混在中间时一眼看不出来
            if (Paths.get(arg).normalize().startsWith("..")) {
                return new Check(Refusal.PARENT_ESCAPE, arg);
            }
        }
        return new Check(Refusal.OK, null);
    }

    /**
     * 读到多少算多少：命令退了、后台进程还攥着管道时读不到头（{@code sleep 20 & echo x}），已经读到的不能跟着丢
     * （第一百零九轮，真浏览器里试出来的：模型只看到「没有输出」）。
     */
    private static final class CappedOutput {
        private final java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        private final int limit;
        private boolean truncated;
        private String failure;

        CappedOutput(int limit) {
            this.limit = limit;
        }

        synchronized void add(byte[] buffer, int read) {
            if (out.size() >= limit) {
                // 已经写满，而这里还读到了东西 —— 这才是真的丢了内容
                truncated = true;
                return;   // 继续排空但丢弃，见 drain 为什么不能停
            }
            int room = limit - out.size();
            if (read > room) {
                out.write(buffer, 0, room);
                truncated = true;
                return;
            }
            // 注意是 read > room 而不是 >=：输出<b>正好</b>等于上限时一个字节都没丢，
            // 不该报截断。报了的话模型会说「还有更多」，而其实没有 —— 它会据此
            // 建议用户换个更窄的命令重跑，白跑一次。
            out.write(buffer, 0, read);
        }

        /** 到上限就停的话，管道很快写满，子进程阻塞在 write 上再也退不出去 —— 一个「日志很多但确实成功了」的构建会被报成超时。宁可多读几 MB 丢掉，也要让它自己跑完，把真实的退出码带回来。 */
        void drain(InputStream in) throws IOException {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) {
                add(buffer, read);
            }
        }

        synchronized void fail(String message) {
            failure = message;
        }

        synchronized Capture snapshot() {
            String text = out.toString(StandardCharsets.UTF_8);
            return new Capture(failure == null ? text : text + failure, truncated);
        }
    }

    private record Capture(String text, boolean truncated) {
    }

    /**
     * 在<b>父进程</b>的 PATH 上把命令名解析成绝对路径。
     *
     * <p>子进程的环境是清空的，没有 PATH，所以不能指望它自己找。用父进程的 PATH 来<b>找</b>
     * 不等于把它<b>传下去</b> —— 传下去的是固定的那一份。
     */
    static Path resolveOnPath(String name) {
        if (name.contains("/") || name.contains("\\")) {
            return null;        // 只接受命令名，不接受路径
        }
        String path = System.getenv("PATH");
        if (path == null || path.isBlank()) {
            path = "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin";
        }
        for (String dir : path.split(":")) {
            if (dir.isBlank()) {
                continue;
            }
            Path candidate = Paths.get(dir, name);
            if (Files.isRegularFile(candidate) && Files.isExecutable(candidate)) {
                return candidate;
            }
        }
        return null;
    }
}
