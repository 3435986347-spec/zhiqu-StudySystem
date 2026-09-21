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
            "-E", "--expression", "-i", "--interactive");

    private final WorkspaceProperties properties;
    private final WorkspaceAccess access;
    private final WorkspaceGuard guard;
    private final boolean productionProfile;

    public WorkspaceExecutor(WorkspaceProperties properties,
                             WorkspaceService workspaceService,
                             @Value("${spring.profiles.active:}") String activeProfiles) {
        this.properties = properties;
        this.access = workspaceService.access();
        this.guard = access.enabled()
                ? new WorkspaceGuard(access.root(), properties.getAllowedExtensions(), properties.getMaxFileBytes())
                : null;
        this.productionProfile = isProduction(activeProfiles);
        if (this.productionProfile && access.effectiveMode().allowsExec()) {
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

    /** 执行能不能用 —— 档位允许执行，且不是生产 profile。 */
    public boolean enabled() {
        return access.effectiveMode().allowsExec() && !productionProfile;
    }

    /** 当前不能执行的原因；能执行时返回 null。 */
    public String refusalReason() {
        if (productionProfile) {
            return "生产环境下不允许执行命令";
        }
        if (!access.effectiveMode().allowsExec()) {
            return access.refusalReason() != null
                    ? access.refusalReason()
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
        if (name.isEmpty()) {
            throw new BusinessException("没有给出要执行的命令");
        }
        if (!properties.getAllowedCommands().contains(name)) {
            throw new BusinessException("命令不在允许清单里：" + name
                    + "（允许的是 " + String.join("、", properties.getAllowedCommands()) + "）");
        }
        List<String> safeArgs = args == null ? List.of() : args;
        checkArgs(safeArgs);

        WorkspaceGuard.Resolution dir = guard.resolveDirectory(relativeDir);
        if (!dir.ok()) {
            throw new BusinessException("工作目录不可用：" + relativeDir);
        }

        Path binary = resolveOnPath(name);
        if (binary == null) {
            throw new BusinessException("这台机器上找不到命令：" + name);
        }

        List<String> line = new ArrayList<>();
        line.add(binary.toString());
        line.addAll(safeArgs);

        ProcessBuilder builder = new ProcessBuilder(line)
                .directory(dir.path().toFile())
                .redirectErrorStream(true);
        // 主进程的环境里有 AI 密钥与数据库密码。清空之后只放回跑得起来所必需的几个，
        // 而且 PATH 给的是固定值，不是父进程那份。
        Map<String, String> env = builder.environment();
        env.clear();
        env.put("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
        env.put("HOME", dir.path().toString());
        env.put("LANG", "en_US.UTF-8");

        long started = System.currentTimeMillis();
        Process spawned = null;
        try {
            final Process process = builder.start();
            spawned = process;

            // 读输出必须在<b>另一个线程</b>上。第一版在这里同步读，而 read() 要等到进程退出
            // 才返回 -1 —— 于是 `sleep 30` 会把读循环阻塞 30 秒，waitFor 的超时根本轮不到执行，
            // 「超时」这条约束等于不存在。判据 超时必须真的把进程杀掉 钉的就是这个。
            Capture[] captured = new Capture[1];
            Thread reader = new Thread(() -> {
                try (InputStream in = process.getInputStream()) {
                    captured[0] = readCapped(in, properties.getExecOutputLimitBytes());
                } catch (IOException e) {
                    captured[0] = new Capture("【读取输出失败：" + e.getMessage() + "】", false);
                }
            }, "workspace-exec-reader");
            reader.setDaemon(true);
            reader.start();

            boolean finished = process.waitFor(properties.getExecTimeoutMs(), TimeUnit.MILLISECONDS);
            if (!finished) {
                process.destroyForcibly();
                process.waitFor(2, TimeUnit.SECONDS);
            }
            // 进程结束后管道才会 EOF，读线程随之收尾。给它一小段时间，超了就用已有的部分。
            reader.join(2000);
            Capture capture = captured[0] == null ? new Capture("", false) : captured[0];

            long millis = System.currentTimeMillis() - started;
            if (!finished) {
                return new ExecResult(name, safeArgs, -1,
                        capture.text() + "\n【超时：超过 " + properties.getExecTimeoutMs() + "ms，已强制结束】",
                        capture.truncated(), true, millis);
            }
            return new ExecResult(name, safeArgs, process.exitValue(),
                    capture.truncated()
                            ? capture.text() + "\n【输出超过 " + properties.getExecOutputLimitBytes() + " 字节，已截断】"
                            : capture.text(),
                    capture.truncated(), false, millis);
        } catch (IOException e) {
            throw new BusinessException("执行失败：" + e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            if (spawned != null) {
                spawned.destroyForcibly();
            }
            throw new BusinessException("执行被中断");
        }
    }


    /**
     * 参数校验。三条，每条挡的是不同的东西。
     */
    private void checkArgs(List<String> args) {
        for (String arg : args) {
            if (arg == null) {
                throw new BusinessException("参数里有空值");
            }
            // 一、行内代码：这是唯一真正的安全判定，见类注释
            if (INLINE_CODE_FLAGS.contains(arg)) {
                throw new BusinessException("不接受行内代码参数 " + arg
                        + " —— 只能执行工作区里已经存在的文件，那样用户才看得到要跑的是什么");
            }
            // 二、绝对路径：命令的作用范围要跟着工作区走
            if (arg.startsWith("/") || arg.startsWith("~")) {
                throw new BusinessException("参数不接受绝对路径：" + arg);
            }
            // 三、往上跳：同上，而且 .. 混在中间时一眼看不出来
            if (Paths.get(arg).normalize().startsWith("..")) {
                throw new BusinessException("参数不接受跳出工作区的路径：" + arg);
            }
        }
    }

    /** 读输出，最多读 limit 字节；到顶就停下并标记，而不是继续读到内存炸掉。 */
    private static Capture readCapped(InputStream stream, int limit) throws IOException {
        byte[] buffer = new byte[8192];
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        int read;
        boolean truncated = false;
        while ((read = stream.read(buffer)) != -1) {
            if (out.size() >= limit) {
                // 已经写满，而这里还读到了东西 —— 这才是真的丢了内容
                truncated = true;
                continue;   // 继续排空但丢弃，见下面为什么不能直接 break
            }
            int room = limit - out.size();
            if (read > room) {
                out.write(buffer, 0, room);
                truncated = true;
                continue;
            }
            // 注意是 read > room 而不是 >=：输出<b>正好</b>等于上限时一个字节都没丢，
            // 不该报截断。报了的话模型会说「还有更多」，而其实没有 —— 它会据此
            // 建议用户换个更窄的命令重跑，白跑一次。
            out.write(buffer, 0, read);
        }
        // 到上限就 break 的话，管道很快写满，子进程阻塞在 write 上再也退不出去 ——
        // 一个「日志很多但确实成功了」的构建会被报成超时。宁可多读几 MB 丢掉，
        // 也要让它自己跑完，把真实的退出码带回来。
        return new Capture(out.toString(StandardCharsets.UTF_8), truncated);
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
