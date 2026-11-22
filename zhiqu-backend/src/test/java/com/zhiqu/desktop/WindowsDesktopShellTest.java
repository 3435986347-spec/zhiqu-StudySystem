package com.zhiqu.desktop;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

class WindowsDesktopShellTest {
    private static final Path ROOT = Path.of("..").toAbsolutePath().normalize();
    private static final Path CHECKS = ROOT.resolve("deploy/desktop/windows-checks");
    private static final Path EXE = CHECKS.resolve("bin/Release/net48/ZhiquWindowsChecks.exe");
    private static Path work;

    @BeforeAll
    static void build() throws Exception {
        Assumptions.assumeTrue(System.getProperty("os.name", "").toLowerCase().contains("windows"), "Windows 原生外壳检查");
        work = Files.createTempDirectory("zhiqu-windows-shell-test-");
        String dotnet = System.getenv("DOTNET_EXE");
        if (dotnet == null || dotnet.isBlank()) dotnet = "dotnet";
        Result built = run(180, "build", dotnet, "build", CHECKS.resolve("WindowsChecks.csproj").toString(), "-c", "Release");
        assertEquals(0, built.code, built.text);
        assertTrue(Files.isRegularFile(EXE), "检查程序没生成");
    }

    @AfterAll
    static void clean() throws Exception {
        if (work == null) return;
        try (var paths = Files.walk(work)) {
            paths.sorted((a, b) -> b.getNameCount() - a.getNameCount()).forEach(path -> {
                try { Files.deleteIfExists(path); } catch (IOException ignored) { }
            });
        }
    }

    @Test
    @DisplayName("Windows 路径、草稿、版本清单、注入边界和干净环境：真编译 C# 后执行")
    void logic() throws Exception {
        Result result = check("logic", work.resolve("logic"));
        assertEquals("true", result.values.get("logic.ok"), result.text);
    }

    @Test
    @DisplayName("打包 Node 真跑本机轮次、直接命令、草稿确认、停止与进程树回收")
    void packagedAgent() throws Exception {
        Result result = check("agent", work.resolve("agent"), windowsPackage().toString());
        assertEquals("true", result.values.get("agent.ok"), result.text);
        assertTrue(Integer.parseInt(result.values.get("agent.streams")) >= 4, result.text);
        assertEquals("fatal,exit,redacted", result.values.get("agent.brokenHost"), result.text);
    }

    @Test
    @DisplayName("交付 exe 自己释放内嵌官方 Node，经 zqLocal 跑一轮、确认草稿并读回；不碰真实应用状态")
    void packagedExecutable() throws Exception {
        Result result = run(60, "production", "node", CHECKS.resolve("production-smoke.cjs").toString(),
                windowsPackage().toString(), work.resolve("production").toString());
        assertEquals(0, result.code, result.text);
        assertEquals("true", result.values.get("production.ok"), result.text);
        assertEquals("v22.23.2", result.values.get("production.node"), result.text);
    }

    @Test
    @DisplayName("自更新坏 SHA 不安装；好包等主进程退出、替换、重启并清理旧 exe")
    void updateAndRestart() throws Exception {
        Path directory = work.resolve("update");
        Result result = check("update", directory, windowsPackage().toString());
        try {
            assertEquals("true", result.values.get("update.ok"), result.text);
            Path target = Path.of(result.values.get("update.target"));
            Path marker = target.resolveSibling("restarted.marker");
            long until = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
            while (!Files.exists(marker) && System.nanoTime() < until) Thread.sleep(200);
            assertTrue(Files.exists(marker), "更新后的进程没有重启：\n" + result.text);
            assertEquals(result.values.get("update.expected"), sha256(target), "目标 exe 没被替换成下载的包");
            assertFalse(Files.exists(Path.of(target + ".old")), "旧 exe 没清掉");
        } finally {
            result.deleteLog();
        }
    }

    @Test
    @DisplayName("真 WebView2：来源/iframe、选目录、完整轮次、快照、通知、正式胶囊外观、真实鼠标拖动与展开")
    void webView() throws Exception {
        Path directory = work.resolve("web");
        Result result = check("web", directory, windowsPackage().toString());
        assertEquals("true", result.values.get("web.ok"), result.text);
        assertEquals("5", result.values.get("web.streams"), "重复 runId 或重复答案又起了一轮");
        assertEquals("2", result.values.get("web.notifications"), result.text);
        assertEquals("140,80", result.values.get("web.drag"), "原生拖动没有生效");
        assertEquals("running,paused", result.values.get("web.pomo"), "番茄钟开始/暂停没有共享生效");
        assertTrue(Files.size(directory.resolve("webview-profile/mini-debug.png")) > 10000, "正式胶囊截图没生成");
    }

    private static Path windowsPackage() {
        String configured = System.getProperty("zhiqu.windowsPackage");
        Path path = configured != null ? Path.of(configured) : ROOT.resolve("build/desktop-windows-native/知趣象限-1.6.0-win-x64.exe");
        if (!Files.isRegularFile(path)) {
            fail("找不到 Windows 打包产物 " + path + "。先运行 deploy/desktop/package-windows-native.ps1 1.6.0，"
                    + "或用 -Dzhiqu.windowsPackage=<绝对路径> 指定；不能把没跑当真通过。");
        }
        return path.toAbsolutePath();
    }

    private static Result check(String mode, Path directory, String... extra) throws Exception {
        String[] command = extra.length == 1
                ? new String[]{EXE.toString(), mode, directory.toString(), extra[0]}
                : new String[]{EXE.toString(), mode, directory.toString()};
        Result result = run(mode.equals("web") ? 120 : 90, mode, command);
        assertEquals(0, result.code, result.text);
        assertEquals("true", result.values.get("done"), result.text);
        return result;
    }

    private static String sha256(Path path) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(path));
        StringBuilder out = new StringBuilder();
        for (byte b : digest) out.append(String.format("%02x", b));
        return out.toString();
    }

    private static Result run(int timeoutSeconds, String name, String... command) throws Exception {
        Path log = Files.createTempFile("zhiqu-windows-" + name + "-", ".log");
        try {
            Process process = new ProcessBuilder(command).directory(ROOT.toFile()).redirectErrorStream(true).redirectOutput(log.toFile()).start();
            process.getOutputStream().close();
            if (!process.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
                process.descendants().forEach(ProcessHandle::destroyForcibly);
                process.destroyForcibly();
                fail("检查超时：" + String.join(" ", command) + "\n" + Files.readString(log));
            }
            String text = Files.readString(log, StandardCharsets.UTF_8);
            Map<String, String> values = new HashMap<>();
            for (String line : text.split("\\R")) {
                int equals = line.indexOf('=');
                if (equals > 0) values.put(line.substring(0, equals), line.substring(equals + 1));
            }
            return new Result(process.exitValue(), text, values, log);
        } finally {
            if (!name.equals("update")) Files.deleteIfExists(log);
        }
    }

    private record Result(int code, String text, Map<String, String> values, Path log) {
        void deleteLog() throws Exception {
            for (int i = 0; i < 50; i++) {
                try { Files.deleteIfExists(log); return; } catch (IOException ignored) { Thread.sleep(100); }
            }
            Files.deleteIfExists(log);
        }
    }
}
