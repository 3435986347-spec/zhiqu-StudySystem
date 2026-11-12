package com.zhiqu.desktop;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 工具循环的轮数：三处数字必须对得上（第一百三十三轮）。
 *
 * <p>用户：「为什么还是提示 20 轮到达上限」。服务器那份 {@code CodeLoopBudget.EXPLICIT} 早就改成了 40，
 * 但<b>桌面应用那一轮在本机跑</b>（第一百二十九轮起），轮数是外壳自己定的 ——
 * {@code LocalAgent.Config.maxRounds} 一直写着 20，服务器改了它不知道。同一句话在网页上能做完、
 * 在桌面上做到一半停下，而且停下来的理由写着「用完了 20 轮」，跟服务器上的配置对不上。
 *
 * <p>三个数：
 * <ul>
 *   <li>服务器：{@code CodeLoopBudget.EXPLICIT} 的 rounds —— 网页 / 命令行那一轮用；</li>
 *   <li>桌面：{@code LocalAgent.roundsSetting()} 的默认值 —— 桌面本机那一轮用；</li>
 *   <li>宿主：{@code code-host.js} 里 {@code Math.min(N, …)} 的上限 —— 谁给的数都不能超过它，
 *       超过就被悄悄夹到 N，桌面这边以为给了 80、实际只有 60。</li>
 * </ul>
 *
 * <p>这是「同一个事实三份拷贝」的典型：靠人记着一起改是记不住的，所以在这里钉住。
 */
class DesktopLocalRoundsTest {

    private static final Path SERVER_BUDGET = Path.of("src/main/java/com/zhiqu/service/ai/CodeLoopBudget.java");
    private static final Path DESKTOP_AGENT = Path.of("../deploy/desktop/macos-shell/LocalAgent.swift");
    private static final Path HOST = Path.of("../zhiqu-cli/src/host/code-host.js");

    private static int group(Path file, String regex, String what) throws IOException {
        Matcher m = Pattern.compile(regex).matcher(Files.readString(file, StandardCharsets.UTF_8));
        assertTrue(m.find(), "找不到" + what + "（判据的锚点没了）：" + file);
        return Integer.parseInt(m.group(1));
    }

    @Test
    @DisplayName("桌面本机那一轮的轮数不比服务器少；宿主的夹取上限也不比它少")
    void 三处轮数对得上() throws IOException {
        int server = group(SERVER_BUDGET, "EXPLICIT = new CodeLoopBudget\\((\\d+),", "服务器那份轮数");
        int desktop = group(DESKTOP_AGENT, "return v > 0 \\? min\\(120, max\\(1, v\\)\\) : (\\d+)", "桌面那份轮数");
        int hostCap = group(HOST, "Math\\.min\\((\\d+), Number\\(run\\.maxRounds\\)", "宿主的上限");

        assertTrue(desktop >= server,
                "桌面本机那一轮只给 " + desktop + " 轮，服务器给 " + server + " 轮 —— 同一句话在桌面上会半路停下");
        assertTrue(hostCap >= desktop,
                "宿主最多只认 " + hostCap + " 轮，桌面给的是 " + desktop + " —— 多出来的会被悄悄夹掉");
        assertTrue(desktop > 20, "又回到 20 轮了（用户：「20 轮太少了」）：" + desktop);
    }
}
