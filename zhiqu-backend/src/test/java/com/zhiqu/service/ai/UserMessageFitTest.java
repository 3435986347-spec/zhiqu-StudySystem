package com.zhiqu.service.ai;

import com.zhiqu.NodeRunner;
import com.zhiqu.SourceText;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 用户消息放进对话的样子（第九轮）：换行缩进原样、超长的保留头尾截中间并写明、上限跟着模型窗口走。
 * 行为在真库里的那一面见 {@code AiConversationLifecycleIntegrationTest} 的三条「粘贴 / 超长 / 长回答」。
 */
class UserMessageFitTest {

    @Test
    @DisplayName("没超：一个字都不改（换行、缩进、空行原样），只去掉首尾空白")
    void 没超原样() {
        String code = "  \n看看这段：\n\ndef f():\n\treturn 1\n    # 注释\n  ";
        UserMessageFit fit = UserMessageFit.of(code, 12_000);
        assertEquals("看看这段：\n\ndef f():\n\treturn 1\n    # 注释", fit.text());
        assertFalse(fit.truncated());
    }

    @Test
    @DisplayName("超了：保留开头和结尾（问题常写在最后），中间写明略去了多少；总长不超过上限太多")
    void 超了保留头尾() {
        String msg = "开头" + "中".repeat(20_000) + "结尾的问题？";
        UserMessageFit fit = UserMessageFit.of(msg, 12_000);
        assertTrue(fit.truncated());
        assertTrue(fit.text().startsWith("开头中"));
        assertTrue(fit.text().endsWith("结尾的问题？"));
        assertTrue(fit.text().contains("这条消息有 " + msg.length() + " 字"), fit.text().substring(9_800, 9_950));
        assertTrue(fit.text().length() <= 12_000, "截完 " + fit.text().length() + " 字");
        assertTrue(fit.notice().contains(String.valueOf(msg.length())));
    }

    @Test
    @DisplayName("截断处不劈开 emoji / 生僻字（UTF-16 代理对）")
    void 不劈开代理对() {
        // 错开一个字符，让开头那一刀、结尾那一刀分别正好落在一个 emoji 的两半之间
        for (String msg : new String[]{"a" + "😀".repeat(8_000), "😀".repeat(8_000) + "a"}) {
            assertWhole(UserMessageFit.of(msg, 12_000).text());
        }
    }

    private static void assertWhole(String t) {
        for (int i = 0; i < t.length(); i++) {
            char c = t.charAt(i);
            if (Character.isHighSurrogate(c)) {
                assertTrue(i + 1 < t.length() && Character.isLowSurrogate(t.charAt(i + 1)), "第 " + i + " 个 char 是半个 emoji");
                i++;
            } else {
                assertFalse(Character.isLowSurrogate(c), "第 " + i + " 个 char 是落单的低代理");
            }
        }
    }

    @Test
    @DisplayName("上限：没填窗口是原来的 12000；填了按 40%，至少 12000、至多 40 万")
    void 上限跟着窗口() {
        assertEquals(12_000, UserMessageFit.limitFor(null));
        assertEquals(12_000, UserMessageFit.limitFor(8_000));
        assertEquals(51_200, UserMessageFit.limitFor(128_000));
        assertEquals(400_000, UserMessageFit.limitFor(1_000_000));
    }

    @Test
    @DisplayName("页面：收到 message.notice 就弹出来（截了要让用户知道），并且多停一会儿")
    void 页面说出来() throws Exception {
        String js = SourceText.stripComments(Files.readString(NodeRunner.API_JS));
        int at = js.indexOf("event === 'message.notice'");
        assertTrue(at > 0, "页面没处理 message.notice —— 后端说了，用户看不到");
        String handler = js.substring(at, js.indexOf('\n', at));
        assertTrue(handler.contains("toast(") && handler.contains("9000"), handler);
        String service = SourceText.stripComments(Files.readString(
                Path.of("src/main/java/com/zhiqu/service/impl/AiServiceImpl.java")));
        assertTrue(service.contains("emitSse(emitter, \"message.notice\""), "后端没把截断说出来");
        assertFalse(service.contains("limitText(message,"), "用户消息又走回了会压平空白的 limitText");
    }
}
