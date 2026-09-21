package com.zhiqu;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 聊天里的代码块着色器：它是这个仓库里<b>唯一</b>一处「把模型/用户给的文本切开、再拼回 HTML」的代码。
 *
 * <h2>为什么值得单独钉一条</h2>
 *
 * <p>别处的富文本都是「整段 {@code esc()} 之后再拼」，一次转义、一处调用，看一眼就知道对不对。
 * 着色器不一样：它必须把一段文本<b>切成很多段</b>，给每段套上 {@code <span>}，再拼回去。
 * 于是转义从「一处」变成了「每一段都要，且恰好一次」—— 少一段就是 XSS，多一次就是页面上
 * 满屏 {@code &amp;lt;}，吞一个字符就是代码显示得不对但没人看得出来。这三种都不会报错。
 *
 * <p>而这段内容的来源正是最不该信的那类：AI 生成的回答、用户粘进来的代码、
 * 以及（工作区功能上线后）从磁盘读出来的文件内容。
 *
 * <h2>这个类为什么要跑 node，而不是在 Java 里重写一遍分词器</h2>
 *
 * <p>重写一遍就是在测一个副本 —— 副本对了不代表线上发布的那份对，两边还会分叉。
 * 所以行为判据直接加载 {@code assets/zhiqu-api.js} 里发布的那份实现
 * （{@code src/test/resources/js/highlight-check.js}）。
 *
 * <h2>没有 node 的机器上，这个类仍然不会给出空的绿</h2>
 *
 * <p>本仓库的教训是「绿分两种：判断看过了没问题，和判断根本没看见」。所以这里分成两条：
 *
 * <ul>
 *   <li>{@link #着色器必须逐段转义} —— <b>永不跳过</b>的结构判据。只看一件事：
 *       token 文本是不是恰好经由 {@code esc(...)} 进入 HTML。它挡得住最危险的那个改动
 *       （把 {@code esc(t[1])} 改回 {@code t[1]}）。</li>
 *   <li>{@link #着色器的行为判据必须全绿} —— 有 node 才跑的行为判据，覆盖对抗性输入、
 *       逐字一致、语言门、以及「着色真的发生了」。没有 node 时它<b>显式失败并说清原因</b>，
 *       而不是悄悄跳过：跳过的绿和通过的绿在报告里长得一模一样。
 *       真的没有 node 又要构建，用 {@code -Dzhiqu.skipNodeTests=true} 把跳过写明白 ——
 *       和 Docker 那批 {@code -Dzhiqu.skipDockerTests=true} 同一个约定。</li>
 * </ul>
 */
class CodeHighlightEscapeTest {

    private static final Path API_JS = Path.of("src/main/resources/static/assets/zhiqu-api.js");
    private static final Path HARNESS = Path.of("src/test/resources/js/highlight-check.js");

    /**
     * 结构判据：{@code highlightCode} 里，token 文本只能经由 {@code esc(...)} 进入 HTML。
     *
     * <p>先剥注释（{@link SourceText#stripComments}）—— 本类的 javadoc 里就写着
     * {@code esc(t[1])} 这几个字，不剥的话这条判据会被它自己的说明文字满足。
     */
    @Test
    void 着色器必须逐段转义() throws Exception {
        String body = SourceText.stripComments(highlightCodeBody());

        // 先给「看到了多少」定个下限：抠空了的话，下面每一条都会真空通过。
        assertTrue(body.length() > 120,
                "抠出来的 highlightCode 函数体只有 " + body.length() + " 字符，太短了 —— "
                        + "多半是函数被改名或改写，判据其实什么都没看到");
        assertTrue(body.contains("tokenizeCode("),
                "highlightCode 必须调用 tokenizeCode —— 抠错地方了：" + body);

        assertTrue(body.contains("esc(t[1])"),
                "每段 token 文本必须经 esc() 转义后才进 HTML。现在的函数体：" + body);

        // 恰好一次：出现在 esc() 之外，就说明有一条未转义的路径。
        assertEquals(1, countOccurrences(body, "t[1]"),
                "t[1] 只允许出现在 esc(t[1]) 里。多出来的那一处就是未转义路径 —— "
                        + "着色器是本仓库唯一把文本切开再拼回 HTML 的地方，漏一段就是 XSS。"
                        + "现在的函数体：" + body);
    }

    /** 行为判据：用对抗性输入实跑发布的那份实现。 */
    @Test
    void 着色器的行为判据必须全绿() throws Exception {
        assertTrue(Files.exists(HARNESS), "行为判据脚本不见了：" + HARNESS.toAbsolutePath());

        String node = findNode();
        if (node == null) {
            assertTrue(Boolean.getBoolean("zhiqu.skipNodeTests"),
                    "找不到 node，代码块着色器的行为判据没有跑 —— 这不是通过。"
                            + "装了 node 再跑；装在非标准位置就用 -Dzhiqu.nodePath=/绝对/路径 指过来；"
                            + "确实没有 node 又要构建，用 -Dzhiqu.skipNodeTests=true 把跳过写明白。"
                            + "手动跑：node " + HARNESS + " " + API_JS);
            return;
        }

        Process p = new ProcessBuilder(node, HARNESS.toString(), API_JS.toString())
                .redirectErrorStream(true)
                .start();
        String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        assertTrue(p.waitFor(60, TimeUnit.SECONDS), "行为判据跑超时了，输出：" + out);

        // 下限：脚本必须真的跑完并自报全绿。退出码 0 单独看是不够的 ——
        // 脚本要是在加载阶段就挂了、或者一条判据都没跑，也可能拿到 0。
        assertTrue(out.contains("ALL-GREEN"),
                "代码块着色器的行为判据没有全绿。完整输出：\n" + out);
        assertEquals(0, p.exitValue(), "行为判据退出码非 0。完整输出：\n" + out);
    }

    /** 从 zhiqu-api.js 里抠出 highlightCode 的函数体。 */
    private static String highlightCodeBody() throws Exception {
        String src = Files.readString(API_JS, StandardCharsets.UTF_8);
        int start = src.indexOf("function highlightCode(");
        assertTrue(start >= 0, "zhiqu-api.js 里找不到 highlightCode —— 着色器被删了或改名了");
        int open = src.indexOf('{', start);
        int depth = 0;
        for (int i = open; i < src.length(); i++) {
            char c = src.charAt(i);
            if (c == '{') depth++;
            else if (c == '}' && --depth == 0) return src.substring(open, i + 1);
        }
        throw new AssertionError("highlightCode 的花括号没有配平，抠不出函数体");
    }

    private static int countOccurrences(String haystack, String needle) {
        int n = 0;
        for (int i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length())) n++;
        return n;
    }

    /**
     * 找到 node。
     *
     * <p>先走 PATH（{@code ProcessBuilder} 自己会查），这对绝大多数命令行构建就够了。
     * 再试几个常见安装位置，是给 PATH 被裁剪过的场景兜底 —— IDE 里跑测试时
     * 拿到的往往是一份很小的 PATH，跟终端里的不是一回事。
     *
     * <p><b>不写死某一台机器上的路径。</b>第一版列的是 homebrew 的
     * {@code /opt/homebrew/bin/node}，而本机的 node 在 {@code ~/.local/node/bin} ——
     * 三个候选全落空，实际只有 PATH 那一条在起作用，清单纯属摆设。
     * 装在别处的话用 {@code -Dzhiqu.nodePath=/绝对/路径} 指过来。
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
}
