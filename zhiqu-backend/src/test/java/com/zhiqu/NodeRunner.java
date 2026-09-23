package com.zhiqu;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 用 node 跑前端行为判据的共享入口 —— <b>唯一定义</b>。
 *
 * <h2>为什么这些判据要跑 node，而不是在 Java 里重写一遍</h2>
 *
 * <p>重写一遍就是在测一个副本：副本绿了不代表 {@code assets/zhiqu-api.js} 里发布的那份对，
 * 而且两边迟早分叉。所以行为判据直接加载发布的那份实现。
 *
 * <h2>没有 node 的机器上不会给出空的绿</h2>
 *
 * <p>本仓库的教训是「绿分两种：判断看过了没问题，和判断根本没看见」。找不到 node 时
 * {@link #run} <b>显式失败并说清原因</b>，而不是悄悄跳过 —— 跳过的绿和通过的绿在报告里
 * 长得一模一样。node 装在非标准位置用 {@code -Dzhiqu.nodePath=<绝对路径>}；
 * 确实没有 node 又要构建，用 {@code -Dzhiqu.skipNodeTests=true} 把跳过写明白，
 * 与 Docker 那批的 {@code -Dzhiqu.skipDockerTests=true} 同一个约定。
 */
public final class NodeRunner {

    public static final Path API_JS = Path.of("src/main/resources/static/assets/zhiqu-api.js");

    /**
     * 跑一个判据脚本。脚本自报全绿（打印 {@code ALL-GREEN}）且退出码 0 才算过。
     *
     * @param extra 追加给脚本的参数 —— 用来把 Java 侧的真实值（比如 CLI 发出的 User-Agent）
     *              交给前端实现去判，而不是在脚本里再写死一份样本
     * @return true = 真的跑了；false = 没有 node 且已显式声明跳过
     */
    public static boolean run(Path harness, Path target, String... extra) throws Exception {
        assertTrue(Files.exists(harness), "判据脚本不见了：" + harness.toAbsolutePath());

        String node = findNode();
        if (node == null) {
            assertTrue(Boolean.getBoolean("zhiqu.skipNodeTests"),
                    "找不到 node，" + harness.getFileName() + " 这条行为判据没有跑 —— 这不是通过。"
                            + "装了 node 再跑；装在非标准位置就用 -Dzhiqu.nodePath=/绝对/路径 指过来；"
                            + "确实没有 node 又要构建，用 -Dzhiqu.skipNodeTests=true 把跳过写明白。"
                            + "手动跑：node " + harness + " " + target);
            return false;
        }

        java.util.List<String> cmd = new java.util.ArrayList<>(java.util.List.of(node, harness.toString(), target.toString()));
        cmd.addAll(java.util.List.of(extra));
        Process p = new ProcessBuilder(cmd)
                .redirectErrorStream(true)
                .start();
        String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertTrue(p.waitFor(60, TimeUnit.SECONDS), "判据跑超时了，输出：\n" + out);

        // 下限：脚本必须真的跑完并自报全绿。只看退出码不够 —— 脚本在加载阶段就挂了、
        // 或者一条判据都没跑，也可能拿到 0。
        assertTrue(out.contains("ALL-GREEN"), "行为判据没有全绿。完整输出：\n" + out);
        assertEquals(0, p.exitValue(), "行为判据退出码非 0。完整输出：\n" + out);
        return true;
    }

    /**
     * 跑一组 {@code node --test} 测试（npm 版 zhiqu 的判据）。退出码 0、TAP 报告里 {@code fail 0}、
     * 而且通过数不少于 {@code minPass} 才算过 —— 通过数有下限，是因为「一条都没跑」的 TAP 报告
     * 也是 {@code fail 0}，和全绿长得一样。
     *
     * @return true = 真的跑了；false = 没有 node 且已显式声明跳过
     */
    public static boolean runTestSuite(Path workDir, java.util.List<String> files, int minPass) throws Exception {
        String node = findNode();
        if (node == null) {
            assertTrue(Boolean.getBoolean("zhiqu.skipNodeTests"),
                    "找不到 node，" + workDir + " 下的 node 测试没有跑 —— 这不是通过。"
                            + "用 -Dzhiqu.nodePath=/绝对/路径 指过来，或者 -Dzhiqu.skipNodeTests=true 把跳过写明白。");
            return false;
        }
        java.util.List<String> cmd = new java.util.ArrayList<>(java.util.List.of(node, "--test"));
        cmd.addAll(files);
        Process p = new ProcessBuilder(cmd).directory(workDir.toFile()).redirectErrorStream(true).start();
        String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertTrue(p.waitFor(300, TimeUnit.SECONDS), "node 测试跑超时了，输出：\n" + out);
        java.util.regex.Matcher pass = java.util.regex.Pattern.compile("(?m)^# pass (\\d+)$").matcher(out);
        java.util.regex.Matcher fail = java.util.regex.Pattern.compile("(?m)^# fail (\\d+)$").matcher(out);
        assertTrue(pass.find() && fail.find(), "没有拿到 TAP 汇总，输出：\n" + out);
        assertEquals("0", fail.group(1), "node 测试有失败。完整输出：\n" + out);
        assertTrue(Integer.parseInt(pass.group(1)) >= minPass,
                "node 测试只通过了 " + pass.group(1) + " 条，下限是 " + minPass + " —— 可能有文件没被跑到。输出：\n" + out);
        assertEquals(0, p.exitValue(), "node 测试退出码非 0。完整输出：\n" + out);
        return true;
    }

    /**
     * 找到 node：先走 PATH（{@code ProcessBuilder} 自己会查），再试几个常见安装位置。
     *
     * <p><b>不写死某一台机器上的路径。</b>第一版只列了 homebrew 的
     * {@code /opt/homebrew/bin/node}，而本机的 node 在 {@code ~/.local/node/bin} ——
     * 候选全落空，实际只有 PATH 那一条在起作用，清单纯属摆设。
     */
    private static String findNode() {
        String configured = System.getProperty("zhiqu.nodePath");
        if (configured != null && !configured.isBlank()) {
            return runs(configured) ? configured : null;
        }
        if (runs("node")) {
            return "node";
        }
        String home = System.getProperty("user.home", "");
        for (String candidate : new String[]{
                home + "/.local/node/bin/node",
                home + "/.nvm/versions/node/current/bin/node",
                "/opt/homebrew/bin/node",
                "/usr/local/bin/node",
                "/usr/bin/node"}) {
            if (runs(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    private static boolean runs(String command) {
        try {
            Process p = new ProcessBuilder(command, "--version").redirectErrorStream(true).start();
            return p.waitFor(10, TimeUnit.SECONDS) && p.exitValue() == 0;
        } catch (Exception e) {
            return false;   // 这个位置上没有 node，试下一个
        }
    }

    private NodeRunner() {
    }
}
