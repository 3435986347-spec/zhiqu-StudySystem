package com.zhiqu.service.agent;

import com.zhiqu.SourceText;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 流式回合的<b>装配窗口</b>失败时，不许变成一个不会结束的转圈。
 *
 * <h2>装配窗口是什么，为什么它单独值得一条</h2>
 *
 * <p>{@code streamChatInternal} 里，{@code beginRun} 之后、跑各相位那个大 {@code try} 之前，
 * 夹着一段「装配」：造 {@code AgentStageExecutor}、建任务图、造 {@code AgentRunContext}。
 * 这段窗口原来不设防。
 *
 * <p>而它里面恰好住着两条本仓库特意写的硬守卫：
 *
 * <ul>
 *   <li>{@code AgentStageExecutor.rejectAmbiguousSlots} —— 两个 runner 抢同一个
 *       {@code (位置, 动作)} 槽位</li>
 *   <li>{@code MultiAgentOrchestratorImpl.materialize} —— 图里有、执行侧没有的幽灵节点</li>
 * </ul>
 *
 * <p>两条的注释都写着「宁可启动就炸」。<b>但执行器是每次流式请求现造的</b>，不是启动期造的。
 * 它们抛出去之后逃到 {@code streamChat} 最外层那个 catch，发一条 SSE error 就完事：
 * run 永远停在 RUNNING、日志一行没有、前端那条消息永远停在 STREAMING。
 *
 * <p>2026-09-21 实际发生了一次：新加的 {@code CODE_AGENT} 把 {@code runAt} 放在 PRE_STREAM#45，
 * 撞上 {@code PLAN_EXTRACTOR} 的 {@code announceAt}。表现是 15 条集成判据一起红、
 * 单跑一次 384 秒、整份日志里没有一个字的异常。找它花掉的时间远多于修它。
 *
 * <h2>这条判据钉的是结构，不是行为</h2>
 *
 * <p>说清楚它能证明什么：它证明装配语句确实<b>写在</b>一个 catch 会收尾的 try 里，
 * 不证明运行时真的收了尾。要那个证明得让 {@code plan()} 在集成环境里抛，
 * 成本远高于它能挡住的回归。
 *
 * <p>所以它不用 {@code contains} 碰运气：先按花括号配平切出那个 catch 块，再在<b>块内</b>
 * 找三件事。这样「别处提到过 errorRun」不会满足它。
 */
class StreamAssemblyFailureGuardTest {

    private static final Path AI_SERVICE =
            Path.of("src/main/java/com/zhiqu/service/impl/AiServiceImpl.java");

    @Test
    void 装配失败必须收掉这个run而不是让它一直转() throws IOException {
        String code = SourceText.stripComments(Files.readString(AI_SERVICE, StandardCharsets.UTF_8));

        int assembly = code.indexOf("new AgentStageExecutor(");
        assertTrue(assembly >= 0, "找不到执行器的构造 —— 判据的锚点没了，它现在什么都没看到");

        int tryStart = code.lastIndexOf("try {", assembly);
        assertTrue(tryStart >= 0 && tryStart < assembly,
                "执行器的构造不在任何 try 里。这段窗口在 beginRun 之后，"
                        + "抛出去就没人接：run 永远 RUNNING、日志一行没有、前端一直转圈");

        String catchBlock = catchBlockAfter(code, tryStart);
        assertTrue(catchBlock != null && !catchBlock.isBlank(),
                "包住装配的那个 try 没有 catch —— 那和没包一样");

        // 建图也必须在同一个 try 里：幽灵节点的守卫住在 plan() 里。
        int plan = code.indexOf("multiAgentOrchestrator.plan(");
        assertTrue(plan > tryStart && plan < code.indexOf("} catch", assembly),
                "建图（plan）不在包住装配的那个 try 里 —— 幽灵节点的守卫抛出来照样没人接");

        assertTrue(catchBlock.contains("errorRun"),
                "装配失败必须把这个 run 收成 ERROR，否则它永远停在 RUNNING。catch 块：" + catchBlock);
        assertTrue(catchBlock.contains("failAssistantMessage"),
                "装配失败必须把那条助手消息从 STREAMING 里放出来，否则前端一直显示正在生成。catch 块："
                        + catchBlock);
        assertTrue(catchBlock.contains("log.error"),
                "装配失败必须记日志。不记的话，配置错误就只表现为一次挂起 —— "
                        + "2026-09-21 那次找了很久，就是因为整份日志里一个字都没有。catch 块：" + catchBlock);
    }

    /** 从 {@code tryStart} 处的 try 配平花括号，取出紧随其后的 catch 块体。 */
    private static String catchBlockAfter(String code, int tryStart) {
        int open = code.indexOf('{', tryStart);
        int depth = 0;
        for (int i = open; i < code.length(); i++) {
            char c = code.charAt(i);
            if (c == '{') {
                depth++;
            } else if (c == '}' && --depth == 0) {
                int catchAt = code.indexOf("catch", i);
                if (catchAt < 0 || catchAt > i + 4) {
                    return null;        // } 之后不是紧跟着 catch
                }
                int body = code.indexOf('{', catchAt);
                int d2 = 0;
                for (int j = body; j < code.length(); j++) {
                    char c2 = code.charAt(j);
                    if (c2 == '{') {
                        d2++;
                    } else if (c2 == '}' && --d2 == 0) {
                        return code.substring(body, j + 1);
                    }
                }
                return null;
            }
        }
        return null;
    }
}
