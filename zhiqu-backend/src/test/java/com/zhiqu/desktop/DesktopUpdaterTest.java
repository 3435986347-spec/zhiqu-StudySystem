package com.zhiqu.desktop;

import com.zhiqu.SourceText;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * 桌面版自己更新（第一百三十二轮，{@code deploy/desktop/macos-shell/Updater.swift}）。
 *
 * <p>用户要的是 codex / dsh 那样：左下角一颗胶囊，点一下自己下载、自己换掉、自己重开。
 * 这里钉三件最容易静默坏掉的事：
 * <ul>
 *   <li>版本比较按数字逐段（"1.0.10" 要比 "1.0.9" 新；按字符串比会得出反的结论，用户就永远收不到更新）；</li>
 *   <li>清单解析认的是服务器的 {@code {"data":{"macos":{...}}}}，没有 macos / 不是 JSON 时当没有，不能崩；</li>
 *   <li>下载完的 sha256 要对得上，替换脚本要等进程退出才动手（不然删掉的是正在运行的自己）。</li>
 * </ul>
 *
 * <p>只在 macOS 上有意义；没有 swiftc 明确失败，要跳过写明 {@code -Dzhiqu.skipSwiftTests=true}。
 */
class DesktopUpdaterTest {

    private static final Path SHELL = Path.of("../deploy/desktop/macos-shell");

    @TempDir
    Path tmp;

    @Test
    @DisplayName("版本比较按数字、清单解析、sha256、换掉自己的脚本要等进程退出")
    void 自更新的纯逻辑() throws Exception {
        Map<String, String> out = runCheck();
        assertEquals("true", out.get("newer.patch"), "1.1.0 没被认成比 1.0.0 新");
        assertEquals("true", out.get("newer.number"), "1.0.10 没被认成比 1.0.9 新（按字符串比就是这个结果）");
        assertEquals("false", out.get("newer.same"), "同一个版本被当成了更新");
        assertEquals("false", out.get("newer.older"), "旧版本被当成了更新（会把人降级）");
        assertEquals("true", out.get("newer.short"), "少写一段（1.1）没被认成比 1.0.9 新");
        assertEquals("true", out.get("newer.suffix"), "带后缀的版本没认对");

        assertEquals("1.1.0", out.get("parse.version"), "清单里的版本没解析出来");
        assertEquals("https://zhiqustudy.com/api/desktop/downloads/macos", out.get("parse.url"),
                "下载地址不是拼在服务器后面的完整地址");
        assertEquals("41925556", out.get("parse.size"));
        assertEquals("78865c60bf0604d241e4625f716679cd3b8db52d2541cf3efe5c5138c52914a0", out.get("parse.sha"),
                "sha256 没统一成小写 —— 和算出来的比会永远对不上");
        assertEquals("true", out.get("parse.none"), "服务器上没有 macos 安装包时应当当没有更新");
        assertEquals("true", out.get("parse.broken"), "返回的不是 JSON 时应当当没有更新，而不是崩");

        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", out.get("sha.abc"),
                "sha256 算错了 —— 下载的包永远「对不上」，更新一次都装不上");

        assertEquals("true", out.get("helper.waits"), "替换脚本没等主程序退出就动手（删的是正在运行的自己）");
        assertEquals("true", out.get("helper.copies"), "替换脚本不是用 ditto 拷的（丢签名 / 丢权限）");
        assertEquals("true", out.get("helper.opens"), "换完没有重新打开");
        assertEquals("true", out.get("helper.cleans"), "换完没有清掉临时目录（每更新一次留一份 40MB）");
        assertEquals("true", out.get("helper.swaps"), "替换不是先拷到旁边再换 —— 拷到一半失败（磁盘满、没权限）就一个版本都不剩");

        assertEquals("0.0.0", out.get("bundle.version"), "没有 Info.plist 时没有退回 0.0.0");
    }

    @Test
    @DisplayName("外壳接上自更新：左下角加胶囊、启动时问一次、点了才下载 / 重启；打包脚本编进两个新文件")
    void 外壳接上自更新() throws Exception {
        String shell = SourceText.stripComments(Files.readString(SHELL.resolve("ZhiquShell.swift"), StandardCharsets.UTF_8));
        assertTrue(shell.contains("startUpdates()"), "启动时没有去问版本");
        assertTrue(shell.contains("updateBadge = UpdateBadge()"), "窗口里没有那颗胶囊");
        assertTrue(shell.contains("updateBadge.leadingAnchor.constraint(equalTo: content.leadingAnchor")
                        && shell.contains("updateBadge.bottomAnchor.constraint(equalTo: content.bottomAnchor"),
                "胶囊不在左下角");
        assertTrue(shell.contains("updater.onChange = { [weak self] phase in self?.apply(phase) }"),
                "更新状态没有接到界面上");
        assertTrue(shell.contains("case .available: updater.download()") && shell.contains("case .ready: updater.restart()"),
                "点胶囊没有分「开始下载」和「重启」两步");
        assertTrue(shell.contains("release.version == skippedUpdate"),
                "点了 × 之后同一个版本还会再冒出来");
        assertTrue(shell.contains("updateTimer?.invalidate()"), "退出时没有停掉轮询");

        String pkg = Files.readString(Path.of("../deploy/desktop/package-macos-native.sh"), StandardCharsets.UTF_8);
        assertTrue(pkg.contains("Updater.swift") && pkg.contains("UpdateBadge.swift"),
                "打包脚本没有编进自更新的两个文件 —— 打出来的应用里没有这个功能");
    }

    private Map<String, String> runCheck() throws Exception {
        Assumptions.assumeTrue(System.getProperty("os.name", "").toLowerCase().contains("mac"), "外壳只在 macOS 上编译");
        Assumptions.assumeFalse(Boolean.getBoolean("zhiqu.skipSwiftTests"), "按 -Dzhiqu.skipSwiftTests=true 跳过");
        if (!new File("/usr/bin/swiftc").canExecute()) {
            fail("这台 Mac 上没有 swiftc（装 Xcode 命令行工具：xcode-select --install），桌面自更新验不了；"
                    + "确实要跳过就加 -Dzhiqu.skipSwiftTests=true");
        }
        Path src = Files.createDirectories(tmp.resolve("src"));
        Files.copy(Path.of("src/test/resources/swift/update-check.swift"), src.resolve("main.swift"));
        Files.copy(SHELL.resolve("Updater.swift"), src.resolve("Updater.swift"));
        Files.copy(SHELL.resolve("Server.swift"), src.resolve("Server.swift"));
        Path bin = tmp.resolve("check");
        run(600, "/usr/bin/swiftc", "-O", "-framework", "AppKit", "-o", bin.toString(),
                src.resolve("main.swift").toString(), src.resolve("Updater.swift").toString(), src.resolve("Server.swift").toString());
        Path work = Files.createDirectories(tmp.resolve("work"));
        String text = run(90, bin.toString(), work.toString());
        Map<String, String> map = new HashMap<>();
        for (String line : text.split("\n")) {
            int eq = line.indexOf('=');
            if (eq > 0) map.put(line.substring(0, eq), line.substring(eq + 1));
        }
        assertEquals("true", map.get("done"), "检查程序没有走完：\n" + text);
        return map;
    }

    private static String run(int timeoutSeconds, String... cmd) throws Exception {
        Path log = Files.createTempFile("update-check", ".log");
        try {
            Process p = new ProcessBuilder(cmd).redirectErrorStream(true).redirectOutput(log.toFile()).start();
            p.getOutputStream().close();
            if (!p.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
                p.destroyForcibly();
                fail("超时：" + String.join(" ", cmd) + "\n" + Files.readString(log));
            }
            String out = Files.readString(log, StandardCharsets.UTF_8);
            assertEquals(0, p.exitValue(), () -> String.join(" ", cmd) + " 失败：\n" + out);
            return out;
        } finally {
            Files.deleteIfExists(log);
        }
    }
}
