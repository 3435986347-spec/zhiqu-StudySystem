package com.zhiqu;

import com.zhiqu.service.ai.TraceSteps;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertTrue;

class AiDecisionTest {

    private static final Path STATIC = Path.of("src/main/resources/static");

    @Test
    void 弹窗在输入框上方_行为直接跑发布脚本() throws Exception {
        String html = Files.readString(STATIC.resolve("ai-assistant.html"), StandardCharsets.UTF_8);
        int workspace = html.indexOf("id=\"zq-ws-bar\"");
        int decision = html.indexOf("id=\"zq-decision\"");
        int composer = html.indexOf("id=\"zq-composer\"");
        assertTrue(workspace > 0 && decision > workspace && composer > decision, "决策面板应在项目栏与输入框之间");
        String css = Files.readString(STATIC.resolve("assets/zhiqu-ui.css"), StandardCharsets.UTF_8);
        assertTrue(css.contains(".zq-decision[hidden]{display:none;}"));
        String phone = css.substring(css.indexOf("@media (max-width: 760px){"));
        assertTrue(phone.contains(".zq-decision{max-height:55vh;"), "手机上面板不能占满整个屏幕");
        assertTrue(TraceSteps.KINDS.contains("decision"));
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/decision-check.js"), STATIC.resolve("assets/pages/ai-assistant.js")),
                "decision-check.js 没有全绿");
    }

    @Test
    void 新客户端声明能力_旧客户端缺省就不声明() throws Exception {
        String js = SourceText.stripComments(SourceText.pageModule("ai-assistant.js"));
        String send = SourceText.functionBody(js, "async function sendAiMessage(queuedText)");
        assertTrue(send.contains("userDecision: true"), "网页没有声明 user_decision_v1 能力");
        assertTrue(com.zhiqu.service.ContextOptionKeys.CLIENT_SUPPLIED.contains(com.zhiqu.service.ContextOptionKeys.USER_DECISION));
        String desktop = SourceText.functionBody(js, "async function sendDesktopTurn(txt, codeCommand)");
        assertTrue(desktop.contains("userDecision: true"), "本机 run 没有声明能力，宿主会退回文字提问");
    }
}
