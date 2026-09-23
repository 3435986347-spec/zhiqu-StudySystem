package com.zhiqu.service.ai;

import com.zhiqu.SourceText;
import com.zhiqu.service.AiWorkspaceService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * coding agent 每一步的叙述，以及循环预算。
 *
 * <p>由来（2026-09-23）：整个工具循环对外只有开头、结尾两条事件；中间读了什么、跑了什么，
 * 网页的执行轨迹和 CLI 都看不到。
 */
class CodeToolNarrationTest {

    @Test
    @DisplayName("每种工具调用都说成一句人话，带上路径 / 命令")
    void 调用叙述() {
        assertEquals("读取 src/Main.java", CodeToolNarration.describeCall("read_workspace_file", "{\"path\":\"src/Main.java\"}"));
        assertEquals("列出目录 （根目录）", CodeToolNarration.describeCall("list_workspace_files", "{}"));
        assertEquals("搜索「TODO」（在 src 下）", CodeToolNarration.describeCall("search_workspace", "{\"query\":\"TODO\",\"path\":\"src\"}"));
        assertEquals("生成草稿 game.html（3 行，未落盘）",
                CodeToolNarration.describeCall("write_workspace_file", "{\"path\":\"game.html\",\"content\":\"a\\nb\\nc\\n\"}"));
        assertEquals("运行 python3 test.py -v",
                CodeToolNarration.describeCall("run_workspace_command", "{\"command\":\"python3\",\"args\":[\"test.py\",\"-v\"]}"));
        assertEquals("读知识页 薄弱点", CodeToolNarration.describeCall("read_wiki_page", "{\"title\":\"薄弱点\"}"));
    }

    /** 叙述是旁白：模型给了坏参数时，它不能抛出去把工具循环拖垮。 */
    @Test
    @DisplayName("参数不是合法 JSON / 工具名为空时不抛，给出兜底说法")
    void 坏参数不抛() {
        assertEquals("读取 （未给出路径）", CodeToolNarration.describeCall("read_workspace_file", "{不是json"));
        assertEquals("调用 （未知工具）", CodeToolNarration.describeCall(null, null));
        assertEquals("读取 （未给出路径）", CodeToolNarration.describeCall("read_workspace_file", "{\"path\":null}"));
    }

    @Test
    @DisplayName("结果只回显命令输出与拒绝；读到的文件内容不回显（那是给模型看的）")
    void 结果回显范围() {
        assertEquals("退出码 0，用时 12ms\nok", CodeToolNarration.describeResult("run_workspace_command", "退出码 0，用时 12ms\nok"));
        assertEquals("操作被拒绝：这一轮没有给你「x」这个工具。",
                CodeToolNarration.describeResult("x", "操作被拒绝：这一轮没有给你「x」这个工具。\n如实告诉用户"));
        assertNull(CodeToolNarration.describeResult("read_workspace_file", "public class Main {}"),
                "读文件的内容被回显了 —— 几百行源码会把真正的步骤冲掉");
        assertNull(CodeToolNarration.describeResult("run_workspace_command", ""));
    }

    @Test
    @DisplayName("命令输出过长时截头，并且说出截了")
    void 输出截头() {
        String longOut = "line\n".repeat(CodeToolNarration.OUTPUT_MAX_LINES + 10);
        String shown = CodeToolNarration.describeResult("run_workspace_command", longOut);
        assertTrue(shown.split("\n").length <= CodeToolNarration.OUTPUT_MAX_LINES + 1, "没有按行截");
        assertTrue(shown.endsWith("只显示开头）"), "截了却没说：" + shown);
        String wide = "x".repeat(CodeToolNarration.OUTPUT_MAX_CHARS * 2);
        String shownWide = CodeToolNarration.describeResult("run_workspace_command", wide);
        assertTrue(shownWide.length() < CodeToolNarration.OUTPUT_MAX_CHARS + 40, "没有按字符截");
        assertTrue(shownWide.endsWith("只显示开头）"));
    }

    // ── 预算 ─────────────────────────────────────────────────────────────

    @Test
    @DisplayName("预算：显式按「代码」比关键词触发大；关键词触发维持 4 轮 30 秒")
    void 预算两档() {
        CodeLoopBudget kw = CodeLoopBudget.forRequest(false);
        CodeLoopBudget ex = CodeLoopBudget.forRequest(true);
        assertEquals(new CodeLoopBudget(4, 30_000L), kw, "关键词门是刻意过触发的，它的预算必须小");
        assertTrue(ex.rounds() > kw.rounds() && ex.millis() > kw.millis(),
                "显式请求的预算没有比关键词触发大 —— 写一个完整的小游戏在 4 轮 30 秒里做不完");
    }

    /** 循环跑完之后还要写最终回答；循环自己就把整条流的时间用光，回答就永远出不来。 */
    @Test
    @DisplayName("预算：显式档的时长要给最终回答留出至少一分钟（整条流 5 分钟超时）")
    void 预算小于流超时() {
        assertTrue(CodeLoopBudget.EXPLICIT.millis() + 60_000L <= AiWorkspaceService.STREAM_TIMEOUT_MS,
                "code agent 的预算把流超时吃掉了：" + CodeLoopBudget.EXPLICIT + " vs " + AiWorkspaceService.STREAM_TIMEOUT_MS);
    }

    // ── 接线 ─────────────────────────────────────────────────────────────

    /**
     * 每一次工具调用都要发叙述，而且要在<b>执行之前</b> —— 否则一个跑 30 秒的命令，
     * 用户在这 30 秒里看到的是「什么也没发生」。
     */
    @Test
    @DisplayName("工具循环：每次调用执行前发 call 叙述，执行后发 result；预算由 CodeLoopBudget 决定")
    void 工具循环接线() throws IOException {
        String code = SourceText.stripComments(Files.readString(
                Path.of("src", "main", "java", "com", "zhiqu", "service", "impl", "AiServiceImpl.java"),
                StandardCharsets.UTF_8));
        int loop = code.indexOf("for (JsonNode call : toolCalls)");
        assertTrue(loop > 0, "找不到工具调用循环 —— 判据的锚点没了");
        int narrateCall = code.indexOf("CodeToolNarration.describeCall(name, argsRaw)", loop);
        int execute = code.indexOf("executeWorkspaceTool(name, argsRaw, loop)", loop);
        int narrateResult = code.indexOf("CodeToolNarration.describeResult(name, result)", loop);
        assertTrue(narrateCall > loop && narrateCall < execute,
                "call 叙述不在执行之前 —— 长命令跑着的时候用户看到的是一片空白");
        assertTrue(narrateResult > execute, "没有在执行之后发 result 叙述 —— 命令输出看不到");
        assertTrue(code.contains("CodeLoopBudget.forRequest(AgentPlanDecision.codeModeRequested(contextOptions))"),
                "循环预算没有按「是否显式按了代码」分档");
        assertTrue(code.contains("round < budget.rounds()") && code.contains("> budget.millis()"),
                "循环没有用预算的轮数与时长");
        assertTrue(code.contains("ctx.emit(\"agent.step.note\", payload)"),
                "叙述没有作为 agent.step.note 发出去 —— 网页和 CLI 都收不到");
    }
}
