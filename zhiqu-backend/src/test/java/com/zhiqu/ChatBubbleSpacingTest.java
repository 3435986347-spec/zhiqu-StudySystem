package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * AI 助手的聊天气泡上下不该空一大截。
 *
 * <p>由来（2026-09-23）：用户说「发消息时气泡上下太宽了，AI 回复也是」。实测一行字的气泡 64px 高、
 * 文字上方空 20px；以标题开头的回复空 26px。原因是 renderMarkdown 给每段都带 margin:8px 0（标题 14px），
 * 在气泡里第一段 / 最后一段的外边距和气泡自己 11px 的内边距叠在一起。改后同样的内容 42px、上下各 9px。
 *
 * <p>这里钉结构（气泡有 {@code zq-msg-body} 类、内边距收窄、样式表里有去首尾外边距的规则）；
 * 尺寸是在浏览器里用线上 renderMarkdown 生成的预览实测的。
 */
class ChatBubbleSpacingTest {

    @Test
    @DisplayName("气泡带 zq-msg-body 类，竖向内边距不超过 8px")
    void 气泡收窄() throws Exception {
        String js = SourceText.stripComments(Files.readString(NodeRunner.API_JS, StandardCharsets.UTF_8));
        Matcher m = Pattern.compile("data-msg-body=\"' \\+ i \\+ '\" class=\"zq-msg-body\" style=\"[^\"]*?padding:(\\d+)px").matcher(js);
        assertTrue(m.find(), "气泡没有 zq-msg-body 类（或写法变了）—— 去首尾外边距的规则找不到它");
        assertTrue(Integer.parseInt(m.group(1)) <= 8, "气泡竖向内边距回到了 " + m.group(1) + "px");
    }

    @Test
    @DisplayName("样式表去掉气泡首尾块的外边距（!important，因为外边距写在内联 style 里）")
    void 首尾外边距归零() throws Exception {
        String css = Files.readString(java.nio.file.Path.of("src/main/resources/static/assets/zhiqu-ui.css"), StandardCharsets.UTF_8)
                .replaceAll("(?s)/\\*.*?\\*/", "");
        assertTrue(css.contains(".zq-msg-body>:first-child>:first-child") && css.contains("margin-top:0!important"),
                "没有去掉第一段的上外边距 —— 它会和气泡内边距叠成 20px");
        assertTrue(css.contains(".zq-msg-body>:last-child>:last-child") && css.contains("margin-bottom:0!important"),
                "没有去掉最后一段的下外边距");
    }
}
