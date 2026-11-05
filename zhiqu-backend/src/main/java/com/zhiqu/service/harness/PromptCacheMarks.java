package com.zhiqu.service.harness;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 给 Claude 标缓存（第一百零四轮，用户：Opus 5.5 命中率只有 9%，DeepSeek 55%）。
 * DeepSeek 的前缀缓存是自动的；Claude 只缓存请求里用 cache_control 标过的部分，不标就是全价。
 * 标两处：系统提示（工具定义排在它前面，一起缓存）、最后一条消息的最后一块（滚动：下一次请求能读到这次写的）。
 * 中转的模型走 OpenAI 兼容接口也一样要标，格式是消息内容拆成带 cache_control 的 text 块；不认的由网关去掉重试。
 */
final class PromptCacheMarks {

    private static final Map<String, String> EPHEMERAL = Map.of("type", "ephemeral");

    private PromptCacheMarks() {
    }

    static boolean applies(String providerType, String modelName) {
        return "ANTHROPIC".equals(providerType)
                || ("OPENAI_COMPATIBLE".equals(providerType) && modelName != null && modelName.toLowerCase(Locale.ROOT).contains("claude"));
    }

    private static Map<String, Object> markedText(String text) {
        Map<String, Object> block = new LinkedHashMap<>();
        block.put("type", "text");
        block.put("text", text);
        block.put("cache_control", EPHEMERAL);
        return block;
    }

    static List<Map<String, Object>> markedSystem(String system) {
        return List.of(markedText(system));
    }

    /** Anthropic 格式：最后一条消息的最后一块带上标记。不动传进来的那一份。 */
    @SuppressWarnings("unchecked")
    static List<Map<String, Object>> markLastAnthropic(List<Map<String, Object>> messages) {
        if (messages.isEmpty() || !(messages.get(messages.size() - 1).get("content") instanceof List<?> content) || content.isEmpty()
                || !(content.get(content.size() - 1) instanceof Map<?, ?> lastBlock)) {
            return messages;
        }
        Map<String, Object> marked = new LinkedHashMap<>((Map<String, Object>) lastBlock);
        marked.put("cache_control", EPHEMERAL);
        List<Object> blocks = new ArrayList<>(content);
        blocks.set(blocks.size() - 1, marked);
        Map<String, Object> last = new LinkedHashMap<>(messages.get(messages.size() - 1));
        last.put("content", blocks);
        List<Map<String, Object>> out = new ArrayList<>(messages);
        out.set(out.size() - 1, last);
        return out;
    }

    /** OpenAI 格式：系统提示（第一条）和最后一条消息的内容拆成带标记的 text 块。没有文字的（只有 tool_calls）不标。 */
    static List<Map<String, Object>> markOpenAi(List<Map<String, Object>> messages) {
        List<Map<String, Object>> out = new ArrayList<>(messages);
        if (out.isEmpty()) return out;
        if ("system".equals(out.get(0).get("role"))) out.set(0, markedMessage(out.get(0)));
        if (out.size() > 1) out.set(out.size() - 1, markedMessage(out.get(out.size() - 1)));
        return out;
    }

    private static Map<String, Object> markedMessage(Map<String, Object> message) {
        if (!(message.get("content") instanceof String text) || text.isBlank()) return message;
        Map<String, Object> marked = new LinkedHashMap<>(message);
        marked.put("content", List.of(markedText(text)));
        return marked;
    }
}
