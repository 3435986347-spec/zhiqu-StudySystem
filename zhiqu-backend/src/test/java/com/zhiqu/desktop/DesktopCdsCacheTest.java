package com.zhiqu.desktop;

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
 * 桌面外壳的应用类 CDS 归档（{@code deploy/desktop/macos-shell/CdsCache.swift}，第十轮：启动 3.3 秒 → 1.7 秒）。
 *
 * <p>规矩只有三条，而错的那一面都不报错、只是悄悄变慢或者更糟：有归档就用；没有就这一次顺带生成到 {@code .part}；
 * <b>只有正常结束才改名成正式归档</b>（被 SIGKILL 的可能只写了一半）。这里把 CdsCache.swift 和一个检查程序一起编译、
 * 在临时目录里真走一遍 —— 不开窗口、不起 JVM。JVM 那一侧（SIGTERM 时确实写出归档、下次确实变快）是实测过的，
 * 见 CLAUDE.md 第十轮。
 *
 * <p>只在 macOS 上有意义（外壳只在 macOS 上编译）；macOS 上没有 swiftc 就明确失败并说原因，
 * 要跳过得写明 {@code -Dzhiqu.skipSwiftTests=true} —— 和 node 那批的约定一样。
 */
class DesktopCdsCacheTest {

    @TempDir
    Path tmp;

    @Test
    @DisplayName("有归档就用；没有就生成到 .part；只有正常结束才落成正式归档；被杀的、空的、半截的都删掉；换版本换一份")
    void 归档的三条规矩() throws Exception {
        Map<String, String> out = runCheck();
        checkArchive(out);
    }

    /** 编译并跑一次检查程序（两条判据共用一次编译结果）。 */
    private Map<String, String> runCheck() throws Exception {
        Assumptions.assumeTrue(System.getProperty("os.name", "").toLowerCase().contains("mac"), "外壳只在 macOS 上编译");
        Assumptions.assumeFalse(Boolean.getBoolean("zhiqu.skipSwiftTests"), "按 -Dzhiqu.skipSwiftTests=true 跳过");
        if (!new File("/usr/bin/swiftc").canExecute()) {
            fail("这台 Mac 上没有 swiftc（装 Xcode 命令行工具：xcode-select --install），外壳的归档逻辑验不了；"
                    + "确实要跳过就加 -Dzhiqu.skipSwiftTests=true");
        }
        Path src = Files.createDirectories(tmp.resolve("src"));
        Files.copy(Path.of("src/test/resources/swift/cds-cache-check.swift"), src.resolve("main.swift"));
        Files.copy(Path.of("../deploy/desktop/macos-shell/CdsCache.swift"), src.resolve("CdsCache.swift"));
        Path bin = tmp.resolve("check");
        run(600, "/usr/bin/swiftc", "-O", "-o", bin.toString(), src.resolve("main.swift").toString(), src.resolve("CdsCache.swift").toString());
        Path work = Files.createDirectories(tmp.resolve("work"));
        return parse(run(60, bin.toString(), work.toString()));
    }

    private static void checkArchive(Map<String, String> out) {
        assertEquals(fnv1a("zhiqu"), out.get("fnv"), "文件名用的哈希不稳定（Swift 的 hashValue 每个进程都不一样）");
        assertEquals("true", out.get("first.training"));
        assertTrue(out.get("first.args").startsWith("-XX:ArchiveClassesAtExit=") && out.get("first.args").endsWith(".jsa.part"),
                "第一次应当生成到 .part：" + out.get("first.args"));
        assertEquals("true", out.get("afterClean.archive"), "正常结束了却没落成正式归档");
        assertEquals("false", out.get("afterClean.partial"));
        assertEquals("false", out.get("second.training"));
        assertTrue(out.get("second.args").startsWith("-XX:SharedArchiveFile=") && out.get("second.args").endsWith(".jsa"),
                "有归档却没用：" + out.get("second.args"));
        assertEquals("true", out.get("v2.newName"), "JAR 换了版本还用旧的名字 —— 旧归档对不上新类路径");
        assertEquals("true", out.get("v2.training"));
        assertEquals("false", out.get("afterKill.partial"), "被 SIGKILL 的那份可能是半截，应当删掉");
        assertEquals("false", out.get("afterKill.archive"), "被 SIGKILL 的那份被当成了正式归档");
        assertEquals("true", out.get("afterKill.oldKept"), "新的还没生成成，旧的不该先删");
        assertEquals("true", out.get("stalePartialRemoved"), "上次留下的半截 .part 没清");
        assertEquals("true", out.get("v2.archive"));
        assertEquals("true", out.get("oldRemoved"), "新版本的归档生成了，旧版本的还留着占 80MB");
        assertEquals("false", out.get("emptyPromoted"), "空的 .part 被当成了归档");
        assertEquals("true", out.get("emptyRemoved"));
    }

    /**
     * 实测：JDK 17 的应用类归档对中文路径里的 JAR 只归档一小部分（64MB / 2.15 秒 vs ASCII 路径 86MB / 1.66 秒），
     * 和 locale 无关，软链也不行。应用包就叫「知趣象限.app」，所以外壳在用户机器上拷一份到 ASCII 路径再跑（AppStage）。
     */
    @Test
    @DisplayName("中文路径的应用包：拷一份完整的到 ASCII 路径再跑；有完整副本就复用；半截的重拷；新版本换一份；ASCII 路径不拷；拷不成照原样跑")
    void 中文路径拷到ASCII路径() throws Exception {
        Map<String, String> out = runCheck();
        assertEquals("true", out.get("stage.ascii"), "副本的路径里还有非 ASCII 字符");
        assertEquals("true", out.get("stage.jarCopied"));
        assertEquals("true", out.get("stage.libCopied"), "只拷了瘦 JAR 没拷 lib/ —— Class-Path 找不到依赖，后端起不来");
        assertEquals("true", out.get("stage.marker"));
        assertEquals("true", out.get("stage.reused"), "已有完整副本却又拷了一遍（或者没用它）");
        assertEquals("true", out.get("stage.recopiedHalf"), "没有 .complete 标记的副本被当成了完整的");
        assertEquals("true", out.get("stage.newVersion"), "应用更新之后还在跑旧副本");
        assertEquals("true", out.get("stage.oldRemoved"), "旧版本的副本没清");
        assertEquals("true", out.get("stage.asciiUntouched"), "路径本来就是 ASCII，不该拷");
        assertEquals("true", out.get("stage.fallback"), "拷不成的时候没退回应用包里的那份 —— 后端会起不来");
    }

    private static Map<String, String> parse(String text) {
        Map<String, String> map = new HashMap<>();
        for (String line : text.split("\n")) {
            if (line.startsWith("first.args=") || line.startsWith("second.args=")) {
                map.put(line.substring(0, line.indexOf('=')), line.substring(line.indexOf('=') + 1));
                continue;
            }
            for (String kv : line.trim().split(" ")) {
                int eq = kv.indexOf('=');
                if (eq > 0) {
                    map.put(kv.substring(0, eq), kv.substring(eq + 1));
                }
            }
        }
        return map;
    }

    private static String fnv1a(String text) {
        long hash = 0xcbf29ce484222325L;
        for (byte b : text.getBytes(StandardCharsets.UTF_8)) {
            hash ^= (b & 0xff);
            hash *= 0x100000001b3L;
        }
        return Long.toUnsignedString(hash, 16);
    }

    private static String run(int timeoutSeconds, String... cmd) throws Exception {
        Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
        p.getOutputStream().close();
        if (!p.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
            p.destroyForcibly();
            fail("超时：" + String.join(" ", cmd));
        }
        String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertEquals(0, p.exitValue(), () -> String.join(" ", cmd) + " 失败：\n" + out);
        return out;
    }
}
