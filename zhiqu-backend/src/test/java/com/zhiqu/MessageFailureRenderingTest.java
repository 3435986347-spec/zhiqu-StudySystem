package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 聊天气泡里「这次回答失败了 / 不完整」（第十九轮）。
 *
 * <p>原来：流里来了 error，页面只在<b>一个字都没收到</b>时才把原因写进气泡 —— 已经出来了半截就什么都不说，
 * 看着像是模型说完了；刷新之后失败的回答是个空白气泡（列表接口带着 errorMessage，页面从来不读）；
 * 被截断的回答一个字不说。行为判据在 node 上跑发布的那份实现（{@code msg-failure-check.js}）。
 */
class MessageFailureRenderingTest {

    private static final Path HARNESS = Path.of("src/test/resources/js/msg-failure-check.js");

    @Test
    @DisplayName("气泡：半截正文 + 失败原因都显示、没有正文时原因照样显示、不完整的说明显示、供应商原文转义、等待时说出秒数")
    void 气泡渲染行为判据必须全绿() throws Exception {
        NodeRunner.run(HARNESS, NodeRunner.API_JS);
    }

    /** 渲染对了还不够：流里的 error / done 要把原因和说明放到那条回答上。 */
    @Test
    @DisplayName("流里来了 error：原因放进 errorMessage，不去改正文；done 带着的说明放进 notice")
    void 事件接线() throws Exception {
        String js = SourceText.stripComments(Files.readString(NodeRunner.API_JS, StandardCharsets.UTF_8));
        int at = js.indexOf("else if (event === 'error') {");
        assertTrue(at > 0, "找不到流里 error 事件的处理");
        String onError = js.substring(at, js.indexOf("});", at));
        assertTrue(onError.contains("assistant.errorMessage = "), "error 事件没有把原因放到这条回答上：" + onError);
        assertFalse(onError.contains("assistant.content ="), "error 事件不该改正文 —— 已经出来的半截要留着：" + onError);
        assertTrue(js.contains("if (data && data.notice) assistant.notice = data.notice;"), "done 带着的说明没有放到这条回答上");
    }
}
