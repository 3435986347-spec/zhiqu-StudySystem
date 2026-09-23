package com.zhiqu.service.ai;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** OpenAI 格式的工具对话 → Anthropic。四条硬规矩每条一个判据（违反任何一条，Anthropic 都回 400）。 */
class AnthropicFormatTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static Map<String, Object> call(String id, String name, String args) {
        return AnthropicFormat.toolCall(id, name, args);
    }

    private static final List<Map<String, Object>> LOOP = List.of(
            Map.of("role", "system", "content", "你是 zhiqu"),
            Map.of("role", "system", "content", "工作区是 test/"),
            Map.of("role", "user", "content", "做个小游戏"),
            Map.of("role", "assistant", "content", "", "tool_calls", List.of(
                    call("c1", "list_files", "{}"), call("c2", "read_file", "{\"path\":\"a.js\"}"))),
            Map.of("role", "tool", "tool_call_id", "c1", "content", "a.js"),
            Map.of("role", "tool", "tool_call_id", "c2", "content", "console.log(1)"),
            Map.of("role", "user", "content", "你上一次的回复被截断了"));

    @Test
    @DisplayName("规矩 1：system 消息合并成顶层字段，不出现在 messages 里")
    void system顶层() {
        AnthropicFormat.Request r = AnthropicFormat.fromOpenAi(LOOP, JSON);
        assertEquals("你是 zhiqu\n\n工作区是 test/", r.system());
        assertTrue(r.messages().stream().noneMatch(m -> "system".equals(m.get("role"))), r.messages().toString());
    }

    @Test
    @DisplayName("规矩 2：user / assistant 交替，第一条是 user；开头是 assistant 时补一条占位 user")
    void 交替() {
        AnthropicFormat.Request r = AnthropicFormat.fromOpenAi(LOOP, JSON);
        for (int i = 0; i < r.messages().size(); i++) {
            assertEquals(i % 2 == 0 ? "user" : "assistant", r.messages().get(i).get("role"), r.messages().toString());
        }
        AnthropicFormat.Request cut = AnthropicFormat.fromOpenAi(List.of(
                Map.of("role", "assistant", "content", "上一轮说到一半"),
                Map.of("role", "user", "content", "继续")), JSON);
        assertEquals("user", cut.messages().get(0).get("role"));
        assertEquals(3, cut.messages().size());
    }

    @Test
    @DisplayName("规矩 3：连续的工具结果并进同一条 user，tool_result 排在文字前面；tool_use 的参数是对象")
    @SuppressWarnings("unchecked")
    void 工具结果() {
        AnthropicFormat.Request r = AnthropicFormat.fromOpenAi(LOOP, JSON);
        List<Object> assistant = (List<Object>) r.messages().get(1).get("content");
        assertEquals(2, assistant.size(), "空的助手正文不该变成一个空 text 块：" + assistant);
        Map<String, Object> use = (Map<String, Object>) assistant.get(1);
        assertEquals("tool_use", use.get("type"));
        assertEquals(Map.of("path", "a.js"), use.get("input"));
        List<Object> results = (List<Object>) r.messages().get(2).get("content");
        assertEquals(3, results.size(), results.toString());
        assertEquals("tool_result", ((Map<String, Object>) results.get(0)).get("type"));
        assertEquals("c1", ((Map<String, Object>) results.get(0)).get("tool_use_id"));
        assertEquals("tool_result", ((Map<String, Object>) results.get(1)).get("type"));
        assertEquals("text", ((Map<String, Object>) results.get(2)).get("type"), "文字要排在 tool_result 后面");
    }

    @Test
    @DisplayName("规矩 3（续）：文字先于工具结果到达时，合并后也要把 tool_result 挪到前面")
    @SuppressWarnings("unchecked")
    void 工具结果挪前() {
        // 原来那条用例里工具结果本来就在前面，重排的代码删掉它照样绿（扰动 T13 照出来的）
        AnthropicFormat.Request r = AnthropicFormat.fromOpenAi(List.of(
                Map.of("role", "user", "content", "读一下"),
                Map.of("role", "assistant", "content", "", "tool_calls", List.of(call("c1", "read_file", "{}"))),
                Map.of("role", "user", "content", "（用户中途补了一句）"),
                Map.of("role", "tool", "tool_call_id", "c1", "content", "内容")), JSON);
        List<Object> merged = (List<Object>) r.messages().get(2).get("content");
        assertEquals("tool_result", ((Map<String, Object>) merged.get(0)).get("type"), merged.toString());
        assertEquals("text", ((Map<String, Object>) merged.get(1)).get("type"));
    }

    @Test
    @DisplayName("规矩 4：content 不能为空；截断了的参数（不是合法 JSON）原文包一层，不丢")
    @SuppressWarnings("unchecked")
    void 不为空() {
        AnthropicFormat.Request r = AnthropicFormat.fromOpenAi(List.of(
                Map.of("role", "user", "content", ""),
                Map.of("role", "assistant", "content", "", "tool_calls", List.of(call("c9", "write_file", "{\"path\":\"a")))), JSON);
        Map<String, Object> text = (Map<String, Object>) ((List<Object>) r.messages().get(0).get("content")).get(0);
        assertTrue(!String.valueOf(text.get("text")).isEmpty());
        Map<String, Object> use = (Map<String, Object>) ((List<Object>) r.messages().get(1).get("content")).get(0);
        assertEquals(Map.of("_raw", "{\"path\":\"a"), use.get("input"));
    }

    @Test
    @DisplayName("反方向：Anthropic 的 content → OpenAI 的 content + tool_calls；thinking 不带回")
    void 回来() throws Exception {
        Map<String, Object> msg = AnthropicFormat.toOpenAiMessage(JSON.readTree("""
                [{"type":"thinking","thinking":"想一想"},{"type":"text","text":"好的"},
                 {"type":"tool_use","id":"t1","name":"write_file","input":{"path":"a.html","content":"<p>"}}]"""), JSON);
        assertEquals("好的", msg.get("content"));
        List<?> calls = (List<?>) msg.get("tool_calls");
        assertEquals(1, calls.size());
        Map<?, ?> fn = (Map<?, ?>) ((Map<?, ?>) calls.get(0)).get("function");
        assertEquals("write_file", fn.get("name"));
        assertEquals(Map.of("path", "a.html", "content", "<p>"), JSON.readValue(String.valueOf(fn.get("arguments")), Map.class));
        assertEquals("length", AnthropicFormat.finishReason("max_tokens"));
        assertEquals("tool_calls", AnthropicFormat.finishReason("tool_use"));
    }
}
