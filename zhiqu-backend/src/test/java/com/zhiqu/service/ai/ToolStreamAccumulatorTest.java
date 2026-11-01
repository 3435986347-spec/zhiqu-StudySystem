package com.zhiqu.service.ai;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 流式增量 → 一条完整的助手消息 + 进度事件。输入取自两家供应商真实的流式格式。 */
class ToolStreamAccumulatorTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static final class Log implements ToolStreamAccumulator.Listener {
        final List<String> events = new ArrayList<>();
        @Override public void onText(String d) { events.add("text:" + d); }
        @Override public void onToolStart(int i, String id, String name) { events.add("start:" + i + ":" + name); }
        @Override public void onToolArgs(int i, int total) { events.add("args:" + i + ":" + total); }
    }

    private static void feedOpenAi(ToolStreamAccumulator acc, String... chunks) throws Exception {
        for (String c : chunks) acc.onOpenAiChunk(JSON.readTree(c));
    }

    @Test
    @DisplayName("OpenAI：参数被拆成很多片、两个工具调用交错到达，拼回来的每个都完整；工具名一到就报")
    @SuppressWarnings("unchecked")
    void openAi拼接() throws Exception {
        Log log = new Log();
        ToolStreamAccumulator acc = new ToolStreamAccumulator(log);
        feedOpenAi(acc,
                "{\"choices\":[{\"delta\":{\"content\":\"先建目录\"}}]}",
                "{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"a\",\"function\":{\"name\":\"write_file\",\"arguments\":\"\"}}]}}]}",
                "{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"path\\\":\\\"g/i\"}}]}}]}",
                "{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"b\",\"function\":{\"name\":\"run_command\",\"arguments\":\"{}\"}}]}}]}",
                "{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"ndex.html\\\"}\"}}]}}]}",
                "{\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":120,\"completion_tokens\":30}}");
        Map<String, Object> msg = acc.message();
        assertEquals("先建目录", msg.get("content"));
        List<Map<String, Object>> calls = (List<Map<String, Object>>) msg.get("tool_calls");
        assertEquals(2, calls.size());
        assertEquals("{\"path\":\"g/index.html\"}", ((Map<?, ?>) calls.get(0).get("function")).get("arguments"));
        assertEquals("b", calls.get(1).get("id"));
        assertEquals("tool_calls", acc.finishReason());
        assertEquals(120, acc.promptTokens());
        assertEquals(List.of("text:先建目录", "start:0:write_file"), log.events.subList(0, 2),
                "工具名应在第一片参数之前就报出去：" + log.events);
        assertTrue(log.events.contains("start:1:run_command"));
    }

    @Test
    @DisplayName("OpenAI：兼容实现不给 index 时，新 id 算新的一个；供应商报 length 就是 length（推断不出来）")
    @SuppressWarnings("unchecked")
    void 没有index() throws Exception {
        ToolStreamAccumulator acc = new ToolStreamAccumulator(null);
        feedOpenAi(acc,
                "{\"choices\":[{\"delta\":{\"tool_calls\":[{\"id\":\"x\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\"}}]}}]}",
                "{\"choices\":[{\"delta\":{\"tool_calls\":[{\"function\":{\"arguments\":\"\\\"a\\\"}\"}}]}}]}",
                "{\"choices\":[{\"delta\":{\"tool_calls\":[{\"id\":\"y\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}}]}}]}",
                "{\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}");
        List<Map<String, Object>> calls = (List<Map<String, Object>>) acc.message().get("tool_calls");
        assertEquals(2, calls.size(), calls.toString());
        assertEquals("{\"path\":\"a\"}", ((Map<?, ?>) calls.get(0).get("function")).get("arguments"));
        assertEquals("length", acc.finishReason());
    }

    @Test
    @DisplayName("Anthropic：文本块与 tool_use 块交错，input_json_delta 按块序号归位；无参工具是 {}")
    @SuppressWarnings("unchecked")
    void anthropic() throws Exception {
        Log log = new Log();
        ToolStreamAccumulator acc = new ToolStreamAccumulator(log);
        for (String e : new String[]{
                "{\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":88}}}",
                "{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}",
                "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"好\"}}",
                "{\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"write_file\",\"input\":{}}}",
                "{\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\"}}",
                "{\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"a.html\\\"}\"}}",
                "{\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t2\",\"name\":\"list_files\",\"input\":{}}}",
                "{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":42}}"}) {
            acc.onAnthropicEvent(JSON.readTree(e));
        }
        List<Map<String, Object>> calls = (List<Map<String, Object>>) acc.message().get("tool_calls");
        assertEquals("好", acc.message().get("content"));
        assertEquals("{\"path\":\"a.html\"}", ((Map<?, ?>) calls.get(0).get("function")).get("arguments"));
        assertEquals("{}", ((Map<?, ?>) calls.get(1).get("function")).get("arguments"));
        assertEquals("tool_calls", acc.finishReason());
        assertEquals(88, acc.promptTokens());
        assertEquals(42, acc.completionTokens());
        assertEquals(null, acc.cachedTokens(), "没报缓存就是 null，不是 0");
        assertTrue(log.events.contains("start:0:write_file") && log.events.contains("start:1:list_files"), log.events.toString());
    }

    /**
     * 缓存命中数（第九十三轮）：按命中价记账要用它。三家各报各的字段；Anthropic 的 input_tokens 不含缓存读写，
     * 原来只认它 —— 有缓存时把输入算少了（命中 1000 的请求记成 88）。
     */
    @Test
    @DisplayName("缓存命中数：DeepSeek 的 prompt_cache_hit_tokens、OpenAI 的 cached_tokens、Anthropic 的 cache_read_input_tokens（输入总数含缓存读写）；不报是 null")
    void 缓存命中数() throws Exception {
        ToolStreamAccumulator deepseek = new ToolStreamAccumulator(new Log());
        feedOpenAi(deepseek, "{\"choices\":[{\"delta\":{\"content\":\"好\"},\"finish_reason\":\"stop\"}],"
                + "\"usage\":{\"prompt_tokens\":1200,\"completion_tokens\":5,\"prompt_cache_hit_tokens\":1024,\"prompt_cache_miss_tokens\":176}}");
        // 只带 DeepSeek 自己那两个字段（文档说现在也给 prompt_tokens_details.cached_tokens、数一样；两个都给时这个样本照不出哪个分支在干活）
        assertEquals(1200, deepseek.promptTokens());
        assertEquals(1024, deepseek.cachedTokens());

        ToolStreamAccumulator openai = new ToolStreamAccumulator(new Log());
        feedOpenAi(openai, "{\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],"
                + "\"usage\":{\"prompt_tokens\":900,\"completion_tokens\":5,\"prompt_tokens_details\":{\"cached_tokens\":512}}}");
        assertEquals(512, openai.cachedTokens());

        ToolStreamAccumulator plain = new ToolStreamAccumulator(new Log());
        feedOpenAi(plain, "{\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":1}}");
        assertEquals(null, plain.cachedTokens(), "不报缓存的供应商：null，不是 0");

        ToolStreamAccumulator anthropic = new ToolStreamAccumulator(new Log());
        anthropic.onAnthropicEvent(JSON.readTree("{\"type\":\"message_start\",\"message\":{\"usage\":"
                + "{\"input_tokens\":88,\"cache_read_input_tokens\":1000,\"cache_creation_input_tokens\":200}}}"));
        assertEquals(1288, anthropic.promptTokens(), "Anthropic 的全部输入 = input_tokens + 缓存读 + 缓存写");
        assertEquals(1000, anthropic.cachedTokens());
    }
}
