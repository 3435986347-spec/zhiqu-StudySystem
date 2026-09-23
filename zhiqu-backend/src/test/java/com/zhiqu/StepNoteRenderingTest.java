package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 网页执行轨迹里的 coding agent 逐步叙述（{@code agent.step.note}）。
 *
 * <p>同一份事件命令行 {@code zhiqu} 也在读；网页这边原来直接丢掉了它，
 * 所以在网页里用「代码」按钮时，看不到读了哪些文件、跑了什么命令。
 *
 * <p>行为判据在 node 上跑发布的那份实现（{@code step-note-check.js}）：命令输出是用户机器上
 * 跑出来的任意文本，会被拼进 innerHTML —— 少一个 esc 就是在自己的页面里执行它。
 */
class StepNoteRenderingTest {

    private static final Path HARNESS = Path.of("src/test/resources/js/step-note-check.js");

    @Test
    @DisplayName("叙述的 HTML：对抗性的命令输出与文件名一律转义，长输出截头并说出来")
    void 叙述渲染行为判据必须全绿() throws Exception {
        NodeRunner.run(HARNESS, NodeRunner.API_JS);
    }

    /** 渲染函数对了还不够：事件要真的分派到它，步骤渲染要真的调用它。 */
    @Test
    @DisplayName("agent.step.note 要分派到 addAgentStepNote，renderSteps 要画出 notes")
    void 事件与渲染接线() throws Exception {
        String js = SourceText.stripComments(Files.readString(NodeRunner.API_JS, StandardCharsets.UTF_8));
        assertTrue(js.contains("event === 'agent.step.note') { if (sameNb()) addAgentStepNote(data); }"),
                "流式处理里没有把 agent.step.note 交给 addAgentStepNote —— 叙述到了前端就被丢掉");
        int at = js.indexOf("function renderSteps(");
        assertTrue(at > 0, "找不到 renderSteps");
        String body = js.substring(at, js.indexOf("function artifactTypeLabel(", at));
        assertTrue(body.contains("(s.notes || []).map(stepNoteHtml)"),
                "renderSteps 没有画出步骤下的 notes —— 事件收了、存了，却不显示");
    }
}
