package com.zhiqu.service.agent;

import com.zhiqu.SourceText;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 一轮结束时，执行轨迹里不许留下停在「进行中」的方块。
 *
 * <h2>它挡的是什么</h2>
 *
 * <p>用户在 AI 助手右侧看到的那串方块是 {@link AgentTraceRecorder} 写的。
 * 每个节点开工时是 PENDING/RUNNING，要靠 complete / skip / error 把它收掉。
 * 有一个没收，用户就会看着一个<b>永远转下去</b>的方块 —— 而后端其实早就结束了，
 * 日志干干净净，什么错都没有。这和装配窗口那次是同一个物种
 * （CLAUDE.md「宁可启动就炸」那一段）。
 *
 * <p>兜底的是 {@code settleUnrunTasks}：把还停在 PENDING 的统统收成 SKIPPED。
 * 它必须<b>两条路径上都有</b> —— 成功那条（跑完 COMMIT 相位）和失败那条（catch 里）。
 * 只挂一条的话，另一条上的遗留节点就永远留在那儿。
 *
 * <p>这条判据是拆大类第三刀时补的：记账那一层刚被抽成独立的类，
 * 而「谁在什么时候兜底」这件事此前没有任何东西盯着。
 */
class AgentTraceCompletenessTest {

    private static final Path AI_SERVICE =
            Path.of("src/main/java/com/zhiqu/service/impl/AiServiceImpl.java");

    @Test
    void 成功与失败两条路径都要收掉没跑的节点() throws IOException {
        String code = SourceText.stripComments(Files.readString(AI_SERVICE, StandardCharsets.UTF_8));

        assertEquals(2, count(code, "settleUnrunTasks("),
                "settleUnrunTasks 必须正好出现两次：成功一次、失败一次。"
                        + "少一次就有一条路径会留下永远转下去的方块；"
                        + "多出来的那次通常意味着有人在中途也收了一遍，那会把还要跑的节点提前收掉");

        assertPrecedes(code, "settleUnrunTasks(", "aiWorkspaceService.completeRun(",
                "成功路径：收尾必须在 completeRun 之前 —— run 都标完成了再收，"
                        + "中间那一瞬用户看到的是「已完成但还有方块在转」");
        // 失败路径要锚在<b>主</b> catch 上。errorRun( 的第一次出现是「装配窗口」那个 catch
        // （建执行器 / 建图时就炸了），那里图还没建好，没有节点可收 —— 这条判据第一次跑
        // 就因为锚到了它而红，是判据的锚点选错了，不是代码缺了收尾。
        //
        // 已知缺口，写在这里而不是假装覆盖到了：如果 plan() 在<b>已经创建了几个节点之后</b>
        // 才抛（例如 createTask 中途失败），那几个节点会留在 PENDING。
        // 那一刻 ctx 还不存在（它在图建完之后才造），所以收不了。
        // 触发它要 DB 在建图中途出错，概率极低，代价是几行孤儿记录，不值得为它把 ctx 提前造出来。
        int mainCatch = code.indexOf("errorRunningTasks(");
        assertTrue(mainCatch > 0, "找不到主失败路径 —— 判据的锚点没了");
        String tail = code.substring(mainCatch);
        assertPrecedes(tail, "settleUnrunTasks(", "aiWorkspaceService.errorRun(",
                "失败路径：收尾必须在 errorRun 之前");
    }

    /** {@code needle} 必须出现在 {@code anchor} 之前，且离得足够近（在同一段收尾逻辑里）。 */
    private static void assertPrecedes(String code, String needle, String anchor, String message) {
        int at = code.indexOf(anchor);
        assertTrue(at > 0, "找不到锚点 " + anchor + " —— 判据的锚点没了，它现在什么都没看到");
        int found = code.lastIndexOf(needle, at);
        assertTrue(found > 0 && at - found < 600,
                message + "。实际：" + (found < 0 ? "之前根本没有 " + needle
                        : "相隔 " + (at - found) + " 字符，太远了，多半不在同一段收尾逻辑里"));
    }

    private static int count(String haystack, String needle) {
        int n = 0;
        for (int i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length())) {
            n++;
        }
        return n;
    }
}
