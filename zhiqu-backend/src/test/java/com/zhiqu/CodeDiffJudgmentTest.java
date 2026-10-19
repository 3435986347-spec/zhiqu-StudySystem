package com.zhiqu;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 代码草稿确认弹窗里的 diff。
 *
 * <h2>这个 diff 是用户做决定的<b>唯一</b>依据</h2>
 *
 * <p>确认之后写的是用户自己电脑上的源码，而他判断「要不要确认」看的就是这个 diff。
 * 所以 diff 少显示一行删除，用户确认时就不知道那一行会消失 —— 这类错误肉眼看不出来，
 * 因为渲染出来的东西<b>看起来</b>总是自洽的。
 *
 * <p>行为判据里最硬的一条因此是「把 diff 还原回去必须逐字等于原文」：
 * 它一次证明了「没丢行」「没凭空多行」「没改内容」三件事。
 *
 * <p>另外两类：渲染不得漏出标签（内容来自磁盘上的源码，里面什么都可能有），
 * 以及大文件不做 O(n·m) —— 把浏览器卡死比没有 diff 糟糕得多。
 *
 * <p>跑 node 的细节（为什么不在 Java 里重写、没有 node 时怎么办）见 {@link NodeRunner}。
 */
class CodeDiffJudgmentTest {

    private static final Path HARNESS = Path.of("src/test/resources/js/diff-check.js");

    @Test
    void diff的行为判据必须全绿() throws Exception {
        NodeRunner.run(HARNESS, NodeRunner.API_JS);
    }

    /** 第七十八轮起删除 / 新增的颜色在样式表（原来拼在每一行的内联里，diff-check.js 在 HTML 里找颜色）；行上只有 data-op。 */
    @Test
    void 删除和新增的颜色在样式表里() throws Exception {
        String css = Files.readString(Path.of("src/main/resources/static/assets/zhiqu-ui.css"), StandardCharsets.UTF_8);
        assertTrue(css.contains(".zq-diff-row[data-op=\"del\"]{background:color-mix(in srgb, var(--zq-bad) 12%, transparent);color:var(--zq-bad);}"),
                "删除的行不是红的（--zq-bad）—— 用户看不出哪一行会消失");
        assertTrue(css.contains(".zq-diff-row[data-op=\"add\"]{background:color-mix(in srgb, var(--zq-q2) 12%, transparent);color:var(--zq-q2);}"),
                "新增的行不是 --zq-q2");
    }
}
