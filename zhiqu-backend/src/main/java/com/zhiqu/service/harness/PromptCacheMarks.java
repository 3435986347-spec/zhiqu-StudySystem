package com.zhiqu.service.harness;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 给 Claude 标缓存（第一百零四轮，用户：Opus 5.5 命中率只有 9%，DeepSeek 55%）。
 * DeepSeek 的前缀缓存是自动的；Claude 只缓存请求里用 cache_control 标过的部分，不标就是全价。
 * 标三处（第一百四十轮，原来两处）：系统提示（工具定义排在它前面，一起缓存；这一段开工后不变，用 1 小时）、
 * 上一次压缩留下的那一段的结尾（摘要 + 命令行还回去的工作状态，两次压缩之间不变）、最后一条消息的最后一块（滚动：下一次请求能读到这次写的）。
 * 1 小时的写入价是 2 倍（5 分钟是 1.25 倍），只给最前面那一两万 token：用户看结果想十分钟再说下一句，这一段照样命中。
 * 整段历史要不要也用 1 小时，用户 2026-11-15 定了「量过再定」。不认 1 小时的由网关先退回 5 分钟、再不行才去掉标记。
 * 中转的模型走 OpenAI 兼容接口也一样要标，格式是消息内容拆成带 cache_control 的 text 块；不认的由网关去掉重试。
 */
final class PromptCacheMarks {

    private static final Map<String, String> EPHEMERAL = Map.of("type", "ephemeral");
    private static final Map<String, String> EPHEMERAL_1H = Map.of("type", "ephemeral", "ttl", "1h");
    /** 命令行压缩之后留下的两条消息的开头（compact.js 的 SUMMARY_PREFIX、agent.js 的 RESTORE_HEADER）：从这里认「上一次压缩留下的那一段」 */
    private static final String SUMMARY_PREFIX = "【之前对话的摘要";
    private static final String RESTORE_PREFIX = "（对话刚压缩过";

    private PromptCacheMarks() {
    }

    static boolean applies(String providerType, String modelName) {
        return "ANTHROPIC".equals(providerType)
                || ("OPENAI_COMPATIBLE".equals(providerType) && modelName != null && modelName.toLowerCase(Locale.ROOT).contains("claude"));
    }

    private static Map<String, Object> markedText(String text, boolean longTtl) {
        Map<String, Object> block = new LinkedHashMap<>();
        block.put("type", "text");
        block.put("text", text);
        block.put("cache_control", longTtl ? EPHEMERAL_1H : EPHEMERAL);
        return block;
    }

    static List<Map<String, Object>> markedSystem(String system, boolean longTtl) {
        return List.of(markedText(system, longTtl));
    }

    /** 上一次压缩留下的那一段在哪结束：最后一条「对话刚压缩过」，没有就是最后一条摘要；都没有、或者它就是最后一条（那里本来就标）返回 -1。 */
    static int boundary(List<Map<String, Object>> messages) {
        int at = -1;
        for (int i = 0; i < messages.size(); i++) {
            String text = firstText(messages.get(i).get("content"));
            if (!"user".equals(messages.get(i).get("role")) || text == null) continue;
            if (text.startsWith(RESTORE_PREFIX) || (text.startsWith(SUMMARY_PREFIX) && (at < 0 || !firstText(messages.get(at).get("content")).startsWith(RESTORE_PREFIX)))) {
                at = i;
            }
        }
        return at >= 0 && at < messages.size() - 1 ? at : -1;
    }

    private static String firstText(Object content) {
        if (content instanceof String s) return s;
        if (content instanceof List<?> parts && !parts.isEmpty() && parts.get(0) instanceof Map<?, ?> first && first.get("text") != null) {
            return String.valueOf(first.get("text"));
        }
        return null;
    }

    /** Anthropic 格式：最后一条消息的最后一块带上标记。不动传进来的那一份。 */
    @SuppressWarnings("unchecked")
    static List<Map<String, Object>> markLastAnthropic(List<Map<String, Object>> messages) {
        List<Map<String, Object>> out = new ArrayList<>(messages);
        int boundary = boundary(messages);
        if (boundary >= 0) out.set(boundary, markedLastBlock(out.get(boundary)));
        if (!out.isEmpty()) out.set(out.size() - 1, markedLastBlock(out.get(out.size() - 1)));
        return out;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> markedLastBlock(Map<String, Object> message) {
        if (!(message.get("content") instanceof List<?> content) || content.isEmpty()
                || !(content.get(content.size() - 1) instanceof Map<?, ?> lastBlock)) {
            return message;
        }
        Map<String, Object> marked = new LinkedHashMap<>((Map<String, Object>) lastBlock);
        marked.put("cache_control", EPHEMERAL);
        List<Object> blocks = new ArrayList<>(content);
        blocks.set(blocks.size() - 1, marked);
        Map<String, Object> out = new LinkedHashMap<>(message);
        out.put("content", blocks);
        return out;
    }

    /** OpenAI 格式：系统提示（第一条）和最后一条消息的内容拆成带标记的 text 块。没有文字的（只有 tool_calls）不标。 */
    static List<Map<String, Object>> markOpenAi(List<Map<String, Object>> messages, boolean longTtl) {
        List<Map<String, Object>> out = new ArrayList<>(messages);
        if (out.isEmpty()) return out;
        int boundary = boundary(messages);
        if ("system".equals(out.get(0).get("role"))) out.set(0, markedMessage(out.get(0), longTtl));
        if (boundary > 0) out.set(boundary, markedMessage(out.get(boundary), false));
        if (out.size() > 1) out.set(out.size() - 1, markedMessage(out.get(out.size() - 1), false));
        return out;
    }

    private static Map<String, Object> markedMessage(Map<String, Object> message, boolean longTtl) {
        if (!(message.get("content") instanceof String text) || text.isBlank()) return message;
        Map<String, Object> marked = new LinkedHashMap<>(message);
        marked.put("content", List.of(markedText(text, longTtl)));
        return marked;
    }
}
