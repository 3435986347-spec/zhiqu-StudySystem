package com.zhiqu;

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
 * 「代码」开关在前端的接线。
 *
 * <p>{@code ContextOptionKeysCoverageTest} 只问活壳里有没有出现 {@code codeMode} 这个词 ——
 * 一行注释就能满足它。这里钉的是三件具体的事：
 * <ol>
 *   <li>发送请求体的 {@code contextOptions} 里真的带了它；</li>
 *   <li>只有按钮<b>可见</b>（工作区生效）时才算按下 —— 否则工作区关掉之后，
 *       localStorage 里记着的「按下」会一直把 {@code codeMode:true} 发出去；</li>
 *   <li>按钮的可见性跟着工作区是否生效走，默认隐藏。</li>
 * </ol>
 */
class CodeModeToggleWiringTest {

    private static final Path STATIC = Path.of("src", "main", "resources", "static");

    private static String js() throws IOException {
        return SourceText.stripComments(Files.readString(STATIC.resolve("assets/zhiqu-api.js"), StandardCharsets.UTF_8));
    }

    @Test
    @DisplayName("发送时 contextOptions 里带 codeMode，值取自 codeModeOn()")
    void 发送体带上开关() throws IOException {
        Matcher m = Pattern.compile("contextOptions:\\s*\\{([^}]*)}").matcher(js());
        assertTrue(m.find(), "找不到发送体里的 contextOptions —— 判据的锚点没了");
        assertTrue(m.group(1).contains("codeMode: codeModeOn()"),
                "发送体没带 codeMode —— 按钮按了也白按，后端永远收不到。实际：" + m.group(1));
    }

    @Test
    @DisplayName("codeModeOn 要求按钮可见：工作区关掉后，记住的「按下」不能再发出去")
    void 隐藏时不算按下() throws IOException {
        String code = js();
        int at = code.indexOf("function codeModeOn()");
        assertTrue(at > 0, "找不到 codeModeOn");
        String body = code.substring(at, code.indexOf('}', at) + 1);
        assertTrue(body.contains("!b.hidden") && body.contains("dataset.on === '1'"),
                "codeModeOn 没同时要求「可见」和「按下」。只看按下的话，工作区关掉后 localStorage 里"
                        + "记着的状态会一直发 codeMode:true。实际：" + body);
    }

    @Test
    @DisplayName("按钮默认隐藏，由 loadWorkspace 按工作区是否生效切换")
    void 可见性跟着工作区走() throws IOException {
        String html = Files.readString(STATIC.resolve("ai-assistant.html"), StandardCharsets.UTF_8);
        Matcher b = Pattern.compile("<button id=\"zq-code\"[^>]*>").matcher(html);
        assertTrue(b.find(), "ai-assistant.html 里没有 #zq-code 按钮");
        assertTrue(b.group().contains(" hidden"),
                "#zq-code 默认没有 hidden —— 工作区没开（绝大多数部署）时它也会亮着，按了什么都不会发生");

        String code = js();
        int at = code.indexOf("async function loadWorkspace()");
        assertTrue(at > 0, "找不到 loadWorkspace");
        String head = code.substring(at, code.indexOf("async function paintWorkspace(", at));
        int toggle = head.indexOf("codeToggle.hidden = !wsState.enabled");
        int bail = head.indexOf("if (!wsState.enabled) {");
        assertTrue(toggle > 0, "loadWorkspace 没按 wsState.enabled 切换「代码」按钮");
        assertTrue(bail > 0 && toggle < bail,
                "切换写在了「未启用就 return」之后 —— 工作区关掉时按钮不会被藏起来");
    }
}
