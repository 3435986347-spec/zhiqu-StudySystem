package com.zhiqu.service.harness;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 网关这一侧按上下文窗口裁剪：只按「一轮」丢，工具调用与结果永远成对。 */
class HarnessContextTest {

    private static Map<String, Object> m(String role, String content) {
        return Map.of("role", role, "content", content);
    }

    private static List<Map<String, Object>> conversation() {
        List<Map<String, Object>> out = new ArrayList<>();
        out.add(m("system", "系统"));
        for (int turn = 0; turn < 5; turn++) {
            out.add(m("user", "第 " + turn + " 轮 " + "问".repeat(200)));
            out.add(Map.of("role", "assistant", "content", "", "tool_calls", List.of(Map.of("id", "c" + turn))));
            out.add(Map.of("role", "tool", "tool_call_id", "c" + turn, "content", "结果".repeat(300)));
            out.add(m("assistant", "答".repeat(100)));
        }
        return out;
    }

    @Test
    @DisplayName("估算：中文一字约一个 token，英文约 3.5 字一个 —— 宁可高估")
    void 估算() {
        assertEquals(10, HarnessContext.estimateTokens("一二三四五六七八九十"));
        assertEquals(4, HarnessContext.estimateTokens("hello world"));   // ceil(11 / 3.5)
        assertEquals(5, HarnessContext.estimateTokens("写 index.html"), "中英混排按字符逐个归类：1 个汉字 + ceil(11 / 3.5)");
    }

    @Test
    @DisplayName("超了就从最早的一轮整组丢；system 与最新一轮永远留着；剩下的每条 tool 前面都有它的 tool_calls")
    void 按轮丢() {
        List<Map<String, Object>> all = conversation();
        int total = HarnessContext.estimateMessages(all);
        HarnessContext.Trimmed t = HarnessContext.trim(all, total / 2);
        assertTrue(t.droppedMessages() > 0 && t.droppedMessages() % 4 == 0, "应当整轮（4 条）地丢：" + t.droppedMessages());
        assertEquals("system", t.messages().get(0).get("role"));
        assertEquals("user", t.messages().get(1).get("role"), "裁完之后第一条非 system 必须是一轮的开头");
        assertTrue(String.valueOf(t.messages().get(t.messages().size() - 4).get("content")).startsWith("第 4 轮"));
        assertTrue(t.estimatedTokens() <= total / 2);
        for (int i = 0; i < t.messages().size(); i++) {
            if ("tool".equals(t.messages().get(i).get("role"))) {
                assertTrue(t.messages().get(i - 1).containsKey("tool_calls"), "孤立的工具结果：第 " + i + " 条");
            }
        }
    }

    @Test
    @DisplayName("没超就一条都不动")
    void 不超不动() {
        List<Map<String, Object>> all = conversation();
        HarnessContext.Trimmed t = HarnessContext.trim(all, 1_000_000);
        assertEquals(all, t.messages());
        assertEquals(0, t.droppedMessages());
        assertEquals(0, t.elidedToolOutputs());
    }

    @Test
    @DisplayName("最新一轮自己就超：只把这一轮里较早的工具输出换成占位，结构不动，最近 4 条原样保留")
    void 一轮就超() {
        List<Map<String, Object>> one = new ArrayList<>();
        one.add(m("user", "读完整个项目"));
        for (int i = 0; i < 8; i++) {
            one.add(Map.of("role", "assistant", "content", "", "tool_calls", List.of(Map.of("id", "r" + i))));
            one.add(Map.of("role", "tool", "tool_call_id", "r" + i, "content", "代码".repeat(2000)));
        }
        HarnessContext.Trimmed t = HarnessContext.trim(one, 12_000);
        assertEquals(one.size(), t.messages().size(), "结构不能变");
        assertTrue(t.elidedToolOutputs() > 0);
        long kept = t.messages().stream().filter(x -> "tool".equals(x.get("role")) && !HarnessContext.ELIDED.equals(x.get("content"))).count();
        assertTrue(kept >= 4, "最近的工具输出要原样保留：" + kept);
        assertEquals(HarnessContext.ELIDED, t.messages().get(2).get("content"), "最早的那条应当先被换掉");
    }
}
