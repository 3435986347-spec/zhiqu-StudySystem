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
        return Integer.parseInt(m.group(1).replace("_", ""));
    }

    @Test
    @DisplayName("桌面本机那一轮的轮数不比服务器少；宿主的夹取上限也不比它少")
    void 三处轮数对得上() throws IOException {
        int server = group(SERVER_BUDGET, "EXPLICIT = new CodeLoopBudget\\((\\d+),", "服务器那份轮数");
        String desktop = Files.readString(DESKTOP_AGENT);
        String host = Files.readString(HOST);
        assertTrue(server == 0, "服务器显式代码模式应按第136轮约定不限轮数");
        assertTrue(desktop.contains("return v > 0 ? v : 0"), "桌面默认 0 应不限轮数，配置的正数不能再夹取");
        assertTrue(host.contains("maxRounds: Math.max(0, Number(run.maxRounds) || 0)"),
                "宿主应原样接受外壳的 0（不限）或用户自设轮数，不能另加隐藏上限");
    }

    @Test
    @DisplayName("桌面时间与服务器一致，页面使用外壳返回的预算而不是旧的 250 秒")
    void 三处时间对得上() throws IOException {
        int server = group(SERVER_BUDGET, "EXPLICIT = new CodeLoopBudget\\(\\d+, ([\\d_]+)L", "服务器时间预算");
        int desktop = group(DESKTOP_AGENT, "var timeoutMs = ([\\d_]+)", "桌面时间预算");
        assertTrue(server == 0 && desktop == 0, "第136轮约定显式代码模式默认 0 = 不限时，页面切走不能改变预算");
        String page = Files.readString(Path.of("src/main/resources/static/assets/pages/ai-assistant.js"));
        assertTrue(page.contains("reply.timeoutMs"), "页面没有接外壳的预算，仍可能在 250 秒提前叫停");
        String shell = Files.readString(Path.of("../deploy/desktop/macos-shell/PageView.swift"));
        assertTrue(shell.contains("LocalSnapshot(agent.config)") && shell.contains("replyHandler(snapshot.budget(runId), nil)"),
                "外壳必须把启动时的真实预算交给页面（重连不能变回旧的10分钟）");
    }
}
