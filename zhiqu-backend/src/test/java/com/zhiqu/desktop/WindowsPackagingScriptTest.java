package com.zhiqu.desktop;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Windows 打包脚本只能在 Windows 上跑（jpackage 不做跨平台），这台开发机上执行不了它 ——
 * 所以两件「在新的 Windows 机器上第一次打包」才会暴露的事，只能在这里按源码钉住（2026-09-27 查出）：
 * <ul>
 *   <li>{@code mvn -o}（离线）：新机器的本地仓库是空的，离线构建必然失败；</li>
 *   <li>PowerShell 5.1 的 {@code $ErrorActionPreference = "Stop"} 只管 cmdlet，不管原生命令 ——
 *       {@code mvn}、{@code jpackage} 失败了照样往下走，最后打印「完成」。</li>
 * </ul>
 */
class WindowsPackagingScriptTest {

    private static final Path SCRIPT = Path.of("../deploy/desktop/package-windows.ps1");

    private static List<String> code() throws Exception {
        List<String> out = new ArrayList<>();
        for (String line : Files.readAllLines(SCRIPT)) {
            String t = line.strip();
            if (!t.isEmpty() && !t.startsWith("#")) {
                out.add(t);
            }
        }
        return out;
    }

    @Test
    @DisplayName("每一次调用原生命令（& mvn / & $jpackage）之后紧跟着查退出码")
    void 原生命令都查退出码() throws Exception {
        List<String> lines = code();
        int calls = 0;
        for (int i = 0; i < lines.size(); i++) {
            if (lines.get(i).startsWith("& ")) {
                calls++;
                assertTrue(i + 1 < lines.size() && lines.get(i + 1).startsWith("Assert-Exit "),
                        "「" + lines.get(i) + "」之后没有查退出码：失败了脚本照样往下走、最后打印「完成」");
            }
        }
        assertTrue(calls >= 2, "脚本里应当至少有 mvn 和 jpackage 两次原生调用，只扫到 " + calls + " 次");
        assertTrue(lines.stream().anyMatch(l -> l.startsWith("if ($LASTEXITCODE -ne 0)")), "Assert-Exit 没有真的查 $LASTEXITCODE");
    }

    @Test
    @DisplayName("不离线构建：新 Windows 机器的本地 Maven 仓库是空的")
    void 不离线构建() throws Exception {
        List<String> mvn = code().stream().filter(l -> l.startsWith("& mvn")).toList();
        assertFalse(mvn.isEmpty(), "找不到 mvn 那一行");
        for (String l : mvn) {
            assertFalse(l.matches(".*\\s-o(\\s|$).*") || l.contains("--offline"), l);
        }
    }
}
