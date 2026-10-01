package com.zhiqu.service.workspace;

import com.zhiqu.common.BusinessException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 执行沙箱。<b>默认关闭，只在本机开发时开。</b>
 *
 * <h2>先说清楚这些判据证明的是什么</h2>
 *
 * <p>白名单里有 {@code python3}，而允许它就等于允许任意代码 —— 一段 Python 能删掉用户的
 * 家目录，这一层拦不住。所以下面<b>没有</b>一条判据在证明「代码被关住了」。它们证明的是两件事：
 *
 * <ol>
 *   <li><b>只能跑用户看过的代码</b> —— 禁掉 {@code -c} 一类行内代码开关之后，执行对象只能是
 *       工作区里已经存在的文件，那些文件要么用户自己写的，要么走过 {@code CODE_DRAFT} 确认。
 *       这是这一层唯一真正意义上的安全判定。</li>
 *   <li><b>炸了也炸不大</b> —— 超时、输出上限、工作目录、不继承环境变量。</li>
 * </ol>
 *
 * <p>行为判据用真进程跑（{@code python3}，白名单里本来就有），因为超时和输出上限这两条
 * 只有真跑起来才知道对不对：它们第一版就是错的 —— 输出是<b>同步</b>读的，而 {@code read()}
 * 要等进程退出才返回 -1，于是 {@code sleep 30} 把读循环阻塞 30 秒，{@code waitFor} 的超时
 * 根本轮不到执行。用源码扫描或者 mock 都发现不了，只有真的跑一个死循环才会发现。
 */
class WorkspaceExecutorTest {

    private static WorkspaceProperties props(Path root, String mode) {
        WorkspaceProperties p = new WorkspaceProperties();
        p.setMode(mode);
        p.setRoot(root == null ? "" : root.toString());
        return p;
    }

    private static WorkspaceExecutor executorAt(Path root, String mode, String profiles) {
        WorkspaceProperties p = props(root, mode);
        return new WorkspaceExecutor(p, new WorkspaceService(p, "127.0.0.1"), profiles);
    }

    private static WorkspaceExecutor execAt(Path root) {
        return executorAt(root, "EXEC", "");
    }

    /** 往工作区里放一个 python 脚本 —— 执行对象只能是已经存在的文件，这也是唯一的用法。 */
    private static void script(Path root, String name, String body) throws IOException {
        Files.writeString(root.resolve(name), body, StandardCharsets.UTF_8);
    }

    private static boolean hasPython() {
        return WorkspaceExecutor.resolveOnPath("python3") != null;
    }

    // ── 开关 ──────────────────────────────────────────────────────────────

    /**
     * 默认不能执行。这个默认值本身就是安全边界。
     *
     * <p>OFF / READ / WRITE 三档都不行 —— 「能写就能跑」在别处也许无害，
     * 在这里是在用户的机器上起进程。
     */
    @Test
    void 默认与非EXEC档都不能执行(@TempDir Path root) {
        assertFalse(new WorkspaceExecutor(new WorkspaceProperties(),
                        new WorkspaceService(new WorkspaceProperties(), "127.0.0.1"), "").enabled(),
                "什么都不配的部署必须完全没有执行能力");
        for (String mode : new String[]{"OFF", "READ", "WRITE"}) {
            WorkspaceExecutor e = executorAt(root, mode, "");
            assertFalse(e.enabled(), mode + " 档不该允许执行");
            assertThrows(BusinessException.class, () -> e.exec("python3", List.of("x.py"), ""),
                    mode + " 档下执行必须被拒");
        }
    }

    /** 生产 profile 下一律拒绝，哪怕配置写了 EXEC。 */
    @Test
    void 生产环境下一律不许执行(@TempDir Path root) {
        for (String profile : new String[]{"prod", "production", "prod,metrics", " PROD "}) {
            WorkspaceExecutor e = executorAt(root, "EXEC", profile);
            assertFalse(e.enabled(), "profile=「" + profile + "」时必须禁用执行");
            assertTrue(String.valueOf(e.refusalReason()).contains("生产"),
                    "理由要说清是因为生产环境。实际：" + e.refusalReason());
        }
        assertTrue(executorAt(root, "EXEC", "dev").enabled(), "非生产 profile 下该能用");
    }

    // ── 只能跑看过的代码 ──────────────────────────────────────────────────

    /**
     * 行内代码开关一律拒绝 —— 这是这一层唯一真正的安全判定。
     *
     * <p>{@code python3 -c "<任意程序>"} 里的那段代码没有经过任何人的眼睛：
     * 它既不是用户写的，也没走过 {@code CODE_DRAFT} 的 diff 确认。
     * 禁掉之后，能跑的只有工作区里已经存在的文件。
     */
    @Test
    void 不接受行内代码(@TempDir Path root) {
        WorkspaceExecutor e = execAt(root);
        for (String flag : new String[]{"-c", "-e", "--eval", "--command", "-i"}) {
            BusinessException ex = assertThrows(BusinessException.class,
                    () -> e.exec("python3", List.of(flag, "print(1)"), ""),
                    flag + " 必须被拒");
            assertTrue(ex.getMessage().contains("行内代码"),
                    "理由要说清为什么。实际：" + ex.getMessage());
        }
    }

    /** 白名单外的命令被拒；白名单本身不许有 shell（否则它等于没有）。 */
    @Test
    void 白名单外的命令被拒(@TempDir Path root) {
        WorkspaceExecutor e = execAt(root);
        for (String cmd : new String[]{"sh", "bash", "rm", "curl", "/bin/sh", "../bin/sh"}) {
            assertThrows(BusinessException.class, () -> e.exec(cmd, List.of(), ""), cmd + " 必须被拒");
        }
    }

    /** 参数不接受绝对路径与 `..` —— 命令的作用范围跟着工作区走。 */
    @Test
    void 参数不得指向工作区外(@TempDir Path root) {
        WorkspaceExecutor e = execAt(root);
        for (String arg : new String[]{"/etc/passwd", "~/.ssh/id_rsa", "../../secret.py", ".."}) {
            assertThrows(BusinessException.class, () -> e.exec("python3", List.of(arg), ""),
                    "参数「" + arg + "」必须被拒");
        }
    }

    // ── 炸了也炸不大（真进程）──────────────────────────────────────────────

    @Test
    void 正常脚本要能跑通并带回退出码与输出(@TempDir Path root) throws IOException {
        if (!hasPython()) {
            return;     // 见类注释：这台机器没有 python3 时这几条跑不了
        }
        script(root, "hello.py", "print('工作区你好')\n");
        WorkspaceExecutor.ExecResult r = execAt(root).exec("python3", List.of("hello.py"), "");

        assertEquals(0, r.exitCode(), "输出：" + r.output());
        assertTrue(r.output().contains("工作区你好"), "输出：" + r.output());
        assertFalse(r.timedOut());
        assertFalse(r.truncated());
    }

    /**
     * 超时必须真的把进程杀掉。
     *
     * <p>第一版这里是错的：输出是<b>同步</b>读的，而 {@code read()} 要等进程退出才返回 -1，
     * 于是一个不产出输出的死循环把读循环阻塞住，{@code waitFor} 的超时根本轮不到执行。
     * 源码扫描和 mock 都发现不了，只有真跑一个死循环才会发现。
     */
    @Test
    void 超时必须真的把进程杀掉(@TempDir Path root) throws IOException {
        if (!hasPython()) {
            return;
        }
        script(root, "loop.py", "while True:\n    pass\n");
        WorkspaceProperties p = props(root, "EXEC");
        p.setExecTimeoutMs(1500L);
        WorkspaceExecutor e = new WorkspaceExecutor(p, new WorkspaceService(p, "127.0.0.1"), "");

        long t0 = System.currentTimeMillis();
        WorkspaceExecutor.ExecResult r = e.exec("python3", List.of("loop.py"), "");
        long elapsed = System.currentTimeMillis() - t0;

        assertTrue(r.timedOut(), "死循环必须被判为超时。输出：" + r.output());
        assertTrue(r.output().contains("超时"), "结果里要说清是超时。输出：" + r.output());
        assertTrue(elapsed < 8000,
                "应当在上限（1500ms）附近被杀，实际用了 " + elapsed + "ms —— "
                        + "超过这么多说明超时没生效，而是等进程自己结束");
    }

    /**
     * 输出上限要生效，而且<b>命令仍要正常结束</b>。
     *
     * <p>到上限就停止读取的话，管道很快写满、子进程阻塞在 write 上再也退不出去 ——
     * 一个「日志很多但确实成功了」的构建会被报成超时。所以到上限之后要继续排空并丢弃。
     */
    @Test
    void 输出超上限要截断且命令仍能正常结束(@TempDir Path root) throws IOException {
        if (!hasPython()) {
            return;
        }
        script(root, "flood.py", "for i in range(200000):\n    print('x' * 40)\n");
        WorkspaceProperties p = props(root, "EXEC");
        p.setExecOutputLimitBytes(4096);
        p.setExecTimeoutMs(30_000L);
        WorkspaceExecutor e = new WorkspaceExecutor(p, new WorkspaceService(p, "127.0.0.1"), "");

        WorkspaceExecutor.ExecResult r = e.exec("python3", List.of("flood.py"), "");

        assertTrue(r.truncated(), "8MB 的输出必须被截断");
        assertTrue(r.output().contains("已截断"), "截断了就要说出来，否则模型把半截当全部");
        assertTrue(r.output().length() < 4096 + 200,
                "截断后仍有 " + r.output().length() + " 字符 —— 上限没生效");
        assertFalse(r.timedOut(),
                "输出多不等于超时。到上限就停止读取会让子进程卡在写管道上，"
                        + "一个成功的构建因此被报成超时");
        assertEquals(0, r.exitCode(), "命令本身是成功的，退出码要如实带回来");
    }

    /**
     * 不继承父进程的环境变量。
     *
     * <p>主进程里有 {@code ZHIQU_SYSTEM_AI_API_KEY}、数据库密码、搜索 key。默认继承的话，
     * 用户让 AI「跑一下这个脚本」，脚本里一句 {@code os.environ} 就把它们全拿走，
     * 而输出会原样回到模型上下文里。
     *
     * <h2>判据不维护「良性变量名单」</h2>
     *
     * <p>第一版列了一份 {@code allowed} 白名单，结果在 macOS 上红了：
     * {@code CPATH / LIBRARY_PATH / MANPATH / SDKROOT} 出现在子进程里。
     * 实测（{@code env -i /usr/bin/python3}）证明它们是 Xcode 的 python3 shim <b>自己注入</b>的
     * —— 父 shell 一个都没有。也就是说白名单挡的不是泄漏，而是平台噪声，
     * 而它同时还会在别的平台上漏掉真正的泄漏。
     *
     * <p>所以改成直接断言那条不变量本身：<b>父进程有的变量，子进程里一个都不许有</b>
     * （我们显式放行的三个除外），再加上「子进程的 PATH 是我们给的那份固定值，
     * 不是父进程那份」。两条都与平台无关，也不会被工具注入的名字骗到。
     */
    @Test
    void 子进程不得继承父进程的环境变量(@TempDir Path root) throws IOException {
        if (!hasPython()) {
            return;
        }
        script(root, "dumpenv.py", """
                import os
                print("PATH_VALUE=" + os.environ.get("PATH", ""))
                for k in sorted(os.environ):
                    print("KEY " + k)
                """);
        WorkspaceExecutor.ExecResult r = execAt(root).exec("python3", List.of("dumpenv.py"), "");

        Set<String> childKeys = r.output().lines()
                .filter(l -> l.startsWith("KEY "))
                .map(l -> l.substring(4).trim())
                .collect(Collectors.toSet());
        assertTrue(childKeys.contains("PATH"), "跑得起来所必需的要在。实际：" + childKeys);

        // 一、PATH 必须是我们给的那份固定值，不是父进程那份
        String childPath = r.output().lines()
                .filter(l -> l.startsWith("PATH_VALUE=")).findFirst()
                .map(l -> l.substring("PATH_VALUE=".length())).orElse("");
        assertEquals("/usr/bin:/bin:/usr/sbin:/sbin", childPath,
                "子进程的 PATH 应当是执行器给的固定值。拿到父进程那份说明环境是继承下来的");
        assertNotEquals(System.getenv("PATH"), childPath,
                "子进程的 PATH 与父进程一样 —— 环境继承了");

        // 二、父进程有的，子进程一个都不许有（显式放行的三个、以及解释器自己注入的除外）
        //
        // 「解释器自己注入的」这一项不能手写名单：macOS 的 python3 shim 在完全空的环境下
        // 也会注入 CPATH / LIBRARY_PATH / MANPATH / SDKROOT / __CF_USER_TEXT_ENCODING，
        // 而其中 __CF_USER_TEXT_ENCODING 恰好父进程也有 —— 手写名单要么把它当泄漏（假红），
        // 要么放行它（换个平台就漏掉真泄漏）。所以现场量一次基线：把同一个解释器放进
        // 一个真正空的环境里跑同一个脚本，它打印出来的就是它自己的地板。
        Set<String> toolFloor = envKeysWithEmptyEnvironment(root, "dumpenv.py");
        Set<String> deliberate = Set.of("PATH", "HOME", "LANG");
        List<String> leaked = System.getenv().keySet().stream()
                .filter(k -> !deliberate.contains(k))
                .filter(k -> !toolFloor.contains(k))
                .filter(childKeys::contains)
                .sorted().toList();
        assertEquals(List.of(), leaked,
                "这些变量从父进程漏进了子进程。主进程里有 AI 密钥和数据库密码，"
                        + "一句 os.environ 就能拿走，而输出会回到模型上下文里");

        // 三、下限：父进程本来就得有点东西，否则上面那条是在空集上真空通过
        assertTrue(System.getenv().size() > 5,
                "父进程只有 " + System.getenv().size() + " 个环境变量 —— 判据没有可比对的样本");
    }

/**
     * 同一个解释器在<b>真正空</b>的环境下会自己注入哪些变量 —— 判据的基线。
     *
     * <p>不传 PATH，所以用绝对路径直接起。这样量出来的就是「与继承无关、工具自己加的那些」。
     */
    private static Set<String> envKeysWithEmptyEnvironment(Path root, String scriptName) throws IOException {
        Path python = WorkspaceExecutor.resolveOnPath("python3");
        ProcessBuilder pb = new ProcessBuilder(python.toString(), scriptName)
                .directory(root.toFile())
                .redirectErrorStream(true);
        pb.environment().clear();
        Process p = pb.start();
        String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        try {
            p.waitFor(10, java.util.concurrent.TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return out.lines().filter(l -> l.startsWith("KEY "))
                .map(l -> l.substring(4).trim()).collect(Collectors.toSet());
    }

    /** 工作目录在工作区内，而不是服务器的当前目录。 */
    @Test
    void 工作目录必须在工作区内(@TempDir Path root) throws IOException {
        if (!hasPython()) {
            return;
        }
        Files.createDirectories(root.resolve("sub"));
        script(root.resolve("sub"), "pwd.py", "import os\nprint(os.getcwd())\n");
        WorkspaceExecutor.ExecResult r = execAt(root).exec("python3", List.of("pwd.py"), "sub");

        String cwd = r.output().trim();
        assertTrue(cwd.endsWith("/sub"), "工作目录应当是 sub，实际：" + cwd);
        assertTrue(cwd.startsWith(root.toRealPath().toString()),
                "工作目录必须在工作区内。root=" + root.toRealPath() + " 实际=" + cwd);
    }
}
