package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 回答里按顺序列出的每一步（第一百二十七轮，用户要的：「像 codex 那样把思考 - run command - create - edit - ls 等等命令和结果按顺序列出来」）。
 *
 * <p>行为判据在 node 上跑发布的那份实现（{@code trace-steps-check.js}）：转义、每一种的图标、running / 出错、展开、折叠、省掉的照实说、SSE 合并。
 * 这里另外钉接线：SSE 的 {@code trace.step} 合进回答、done 带回来的那份（库里的）盖上去、流式补丁和全量重画都绑展开、
 * 消息正文里调的是它（没有步骤时一个字都不多）。
 */
class TraceStepsRenderingTest {

    private static final Path STATIC = Path.of("src/main/resources/static");

    private static String page() throws Exception {
        return SourceText.stripComments(Files.readString(STATIC.resolve("assets/pages/ai-assistant.js"), StandardCharsets.UTF_8));
    }

    @Test
    @DisplayName("渲染的行为（node 跑发布的那一份）")
    void 渲染() throws Exception {
        NodeRunner.run(Path.of("src/test/resources/js/trace-steps-check.js"), STATIC.resolve("assets"));
    }

    @Test
    @DisplayName("接线：trace.step 合进这条回答、只重画这一条；done 带的那份盖上去；展开在流式补丁和全量重画之后都还在")
    void 接线() throws Exception {
        String js = page();
        assertEquals(1, count(js, "else if (event === 'trace.step') {"), "流式处理里没有（或者有两处）trace.step 的分支");
        String branch = js.substring(js.indexOf("else if (event === 'trace.step') {"), js.indexOf("else if (event === 'trace.step') {") + 260);
        assertTrue(branch.contains("mergeTraceStep(assistant, data && data.step)"), "trace.step 没合进正在生成的这条回答：\n" + branch);
        assertTrue(branch.contains("patchStreamingMessage(state.messages.indexOf(assistant))"), "trace.step 来一次重画整个聊天区（几十步就是几十次全量重画）：\n" + branch);
        assertTrue(js.contains("if (data && data.steps && data.steps.steps) assistant.steps = data.steps;"), "done 带回来的步骤（库里存的那份）没用上");
        String body = js.substring(js.indexOf("function messageBodyHtml(m, i) {"), js.indexOf("function waitSince(m)"));
        assertTrue(body.contains("traceStepsHtml(m.steps, traceKey)") && body.contains("return steps + reason + body;"), "消息正文里没画步骤，或者没画在正文上面：\n" + body);
        assertTrue(body.contains("(!me && m.steps && m.steps.steps && m.steps.steps.length)"), "没有步骤时也调了渲染（用户的话、老消息不该多出东西）");
        String patch = js.substring(js.indexOf("function patchStreamingMessage(index) {"), js.indexOf("function bindTraceToggles(scope) {"));
        assertTrue(patch.indexOf("state.reasoningExpanded[details.dataset.reasonKey] = details.open;") < patch.indexOf("node.innerHTML = messageBodyHtml(m, index);")
                        && patch.contains("bindTraceToggles(node);"),
                "流式补丁没先存展开状态、没重新绑：点开的那一步，下一个字一到又合上了：\n" + patch);
        String full = js.substring(js.indexOf("function renderAiMessages(opts) {"), js.indexOf("function renderAiMessages(opts) {") + 3000);
        assertTrue(full.contains("bindTraceToggles(host);"), "全量重画之后没绑步骤的展开");
        assertTrue(js.contains("var traceKey = String(m.requestId || reasonKey);")
                        && js.contains("if (!assistant.requestId && data && data.requestId) assistant.requestId = data.requestId;"),
                "展开状态的键不是 requestId：流式时是 _clientKey、收尾重拉之后是 id，点开的步骤一收尾就合上");
    }

    @Test
    @DisplayName("样子在样式表：没有内联样式；用的颜色 / 字号都是令牌；转圈有「减少动效」的退路；手机上的在手机那一段里")
    void 样式() throws Exception {
        String css = Files.readString(STATIC.resolve("assets/zhiqu-ui.css"), StandardCharsets.UTF_8);
        String trace = css.substring(css.indexOf(".zq-trace{"), css.indexOf(".zq-ai-reasoning{"));
        assertTrue(trace.length() > 1000, "扫到的不是步骤那一段样式 —— 空扫会假绿");
        assertTrue(!trace.matches("(?s).*font-size:\\s*\\d+px.*"), "步骤的样式里写死了字号");
        assertTrue(!trace.matches("(?s).*#[0-9a-fA-F]{3,8}\\b.*"), "步骤的样式里写死了颜色（深色模式下不跟着变）");
        assertTrue(trace.contains("@media (prefers-reduced-motion:reduce){.zq-trace-step[data-state=\"running\"] .zq-trace-icon::before{animation:none;}"));
        String phone = css.substring(css.indexOf("@media (max-width: 760px){"));
        assertTrue(phone.contains(".zq-trace-summary{display:none;}"), "手机上一行放不下动作 + 对象 + 小结");
    }

    private static int count(String s, String needle) {
        int n = 0;
        for (int i = s.indexOf(needle); i >= 0; i = s.indexOf(needle, i + needle.length())) {
            n++;
        }
        return n;
    }
}
