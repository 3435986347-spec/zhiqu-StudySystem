package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.opentest4j.AssertionFailedError;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 跑 node 判据的那一层自己的判据。
 *
 * <p>2026-09-24 的一次全量里，{@code HarnessCliNodeSuiteTest} 挂了 999 秒，报告只剩
 * 「cancelled 1」—— 哪一条、为什么，都要去翻一份已经被清掉的临时日志。这里钉三件事：
 * 没过的测试要在报错最前面点名；漏掉的孙子进程不能让 Maven 无限地等；标准输入要给 EOF。
 */
class NodeRunnerTest {

    @Test
    @DisplayName("超过自己时限的测试（node 记成 cancelled 而不是 fail）：报错最前面点名是哪一条、为什么")
    void 被取消的测试要点名(@TempDir Path dir) throws Exception {
        if (!nodeOrDeclaredSkip()) {
            return;
        }
        Files.createDirectories(dir.resolve("test"));
        Files.writeString(dir.resolve("test/slow.test.mjs"), """
                import { test } from 'node:test';
                test('慢到超时的那一条', { timeout: 100 }, async () => { await new Promise((r) => setTimeout(r, 1000)); });
                test('正常的一条', () => {});
                """);
        AssertionFailedError e = assertThrows(AssertionFailedError.class,
                () -> NodeRunner.runTestSuite(dir, List.of("test/slow.test.mjs"), 1));
        String msg = e.getMessage();
        int named = msg.indexOf("✗ 慢到超时的那一条");
        assertTrue(named >= 0, "报错里没点名被取消的那一条：\n" + msg);
        assertTrue(msg.indexOf("timed out", named) > named, "没说为什么：\n" + msg);
        assertTrue(named < msg.indexOf("完整输出"), "点名要在几百行输出之前：\n" + msg);
        assertTrue(!msg.contains("✗ 正常的一条"), "过了的不该被点名：\n" + msg);
    }

    @Test
    @DisplayName("测试留下一个拿着输出管道的孙子进程：等待有上限 —— 到点杀掉并说出来，而不是等到它自己退出")
    void 孙子进程不能无限拖住(@TempDir Path dir) throws Exception {
        if (!nodeOrDeclaredSkip()) {
            return;
        }
        Files.createDirectories(dir.resolve("test"));
        Path pidFile = dir.resolve("grandchild.pid");
        Files.writeString(dir.resolve("test/leak.test.mjs"), """
                import { test } from 'node:test';
                import { spawn } from 'node:child_process';
                test('留下一个孙子进程', () => {
                  const p = spawn(process.execPath, ['-e', "require('fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000)", %s],
                    { stdio: 'inherit', detached: true });
                  p.unref();
                });
                """.formatted(jsString(pidFile.toString())));
        long started = System.nanoTime();
        try {
            AssertionFailedError e = assertThrows(AssertionFailedError.class,
                    () -> NodeRunner.runTestSuite(dir, List.of("test/leak.test.mjs"), 1, 5));
            long ms = (System.nanoTime() - started) / 1_000_000;
            assertTrue(ms < 25_000, "等了 " + ms + " 毫秒 —— 超时没生效，在等孙子进程自己退出");
            assertTrue(e.getMessage().contains("跑超时了（5 秒）"), "要说出是超时：\n" + e.getMessage());
        } finally {
            for (int i = 0; i < 50 && !Files.exists(pidFile); i++) {
                Thread.sleep(100);
            }
            if (Files.exists(pidFile)) {
                ProcessHandle.of(Long.parseLong(Files.readString(pidFile).trim())).ifPresent(ProcessHandle::destroyForcibly);
            }
        }
    }

    @Test
    @DisplayName("标准输入给 EOF：读 stdin 的脚本不会一直等下去")
    void 标准输入要关掉(@TempDir Path dir) throws Exception {
        if (!nodeOrDeclaredSkip()) {
            return;
        }
        Path harness = dir.resolve("stdin-check.js");
        Files.writeString(harness, "process.stdin.on('data', () => {}); process.stdin.on('end', () => console.log('ALL-GREEN'));\n");
        long started = System.nanoTime();
        NodeRunner.run(harness, harness);
        long ms = (System.nanoTime() - started) / 1_000_000;
        assertTrue(ms < 15_000, "等了 " + ms + " 毫秒 —— 标准输入一直没给 EOF");
    }

    /** 与 {@link NodeRunner} 同一个约定：没有 node 时必须显式声明跳过，否则是红。 */
    private static boolean nodeOrDeclaredSkip() {
        if (NodeRunner.findNode() != null) {
            return true;
        }
        assertTrue(Boolean.getBoolean("zhiqu.skipNodeTests"),
                "找不到 node，这条判据没有跑 —— 这不是通过。用 -Dzhiqu.nodePath 指过来，或 -Dzhiqu.skipNodeTests=true 写明跳过。");
        return false;
    }

    private static String jsString(String s) {
        return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'";
    }
}
