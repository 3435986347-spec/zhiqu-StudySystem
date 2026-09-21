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
     * @return true = 真的跑了；false = 没有 node 且已显式声明跳过
     */
    public static boolean run(Path harness, Path target) throws Exception {
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

        Process p = new ProcessBuilder(node, harness.toString(), target.toString())
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
