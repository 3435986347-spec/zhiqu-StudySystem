package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 代码模式在前端的接线。第一百零五轮起没有「代码」按钮了（用户：「感觉多余了」），档位开着就走代码模式。
 *
 * <p>{@code ContextOptionKeysCoverageTest} 只问活壳里有没有出现 {@code codeMode} 这个词 ——
 * 一行注释就能满足它。这里钉的是：发送请求体的 {@code contextOptions} 里真的带了它，值取自 {@code codeModeOn()}；
 * 按钮和它记在 localStorage 里的状态都没了（留着的话关掉工作区之后还会一直发 {@code codeMode:true}）。
 * {@code codeModeOn()} 的行为在 ws-bar-check.js 里真跑。
 */
class CodeModeToggleWiringTest {

    private static final Path STATIC = Path.of("src", "main", "resources", "static");

    private static String js() throws IOException {
        return SourceText.pageModule("ai-assistant.js");   // 第三十七轮起 AI 助手是模块（pages/ai-assistant.js）
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
    @DisplayName("「代码」按钮没了：页面上没有 #zq-code，也不再读写 localStorage 里记的按下状态；codeModeOn 看工作区是不是生效")
    void 按钮没了() throws IOException {
        String html = Files.readString(STATIC.resolve("ai-assistant.html"), StandardCharsets.UTF_8);
        assertFalse(html.contains("zq-code"), "「代码」按钮还在");
        String code = SourceText.stripComments(js());
        assertFalse(code.contains("zq-code") || code.contains("zq.codeMode"), "还在找按钮或者读它记的状态");
        assertTrue(code.contains("function codeModeOn() {") && code.contains("if (!wsStatus || !wsStatus.enabled) return false;"),
                "codeModeOn 不是看工作区是否生效了");
    }
}
