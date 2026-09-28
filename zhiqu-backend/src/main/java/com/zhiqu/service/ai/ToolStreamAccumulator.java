package com.zhiqu.service.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.zhiqu.common.BusinessException;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 把供应商的流式增量拼成一条完整的助手消息，同时把「现在正在发生什么」转给监听者。
 *
 * <p>两种协议各一个入口（{@link #onOpenAiChunk} / {@link #onAnthropicEvent}），出来的事件与最终消息
 * 形状一样 —— 命令行不需要知道背后是哪家。纯状态机，不碰网络：判据直接喂 SSE 数据行。
 *
 * <h2>为什么要把工具参数的进度也转出去</h2>
 *
 * <p>模型写一个 20KB 的文件时，参数要流好几十秒，这期间没有一个字的正文。只转正文的话，命令行看到的
 * 就是一段长时间的沉默 —— 用户说的「一直卡在这里」就是这个样子。所以工具调用一开始就报名字，
 * 参数每长一截就报一次长度。
 */
public final class ToolStreamAccumulator {

    public interface Listener {
        default void onText(String delta) {}
        default void onReasoning(String delta) {}
        default void onToolStart(int index, String id, String name) {}
        default void onToolArgs(int index, int totalChars) {}
    }

    private static final Listener SILENT = new Listener() {};

    private final Listener listener;
    private final StringBuilder text = new StringBuilder();
    private final StringBuilder reasoning = new StringBuilder();
    private final List<Call> calls = new ArrayList<>();
    /** Anthropic 的块序号 → 工具调用序号（文本块也占序号）。 */
    private final Map<Integer, Integer> anthropicBlockToCall = new LinkedHashMap<>();
    private String finishReason;
    private Integer promptTokens;
    private Integer completionTokens;

    private static final class Call {
        String id = "";
        String name = "";
        final StringBuilder arguments = new StringBuilder();
    }

    public ToolStreamAccumulator(Listener listener) {
        this.listener = listener == null ? SILENT : listener;
    }

    // ── OpenAI /chat/completions（stream=true） ─────────────────────────────

    public void onOpenAiChunk(JsonNode root) {
        if (root == null) return;
        if (root.has("error")) {
            JsonNode err = root.get("error");
            throw new BusinessException("模型返回错误：" + (err.isTextual() ? err.asText() : err.path("message").asText(err.toString())));
        }
        JsonNode choice = root.path("choices").path(0);
        JsonNode delta = choice.path("delta");
        String content = delta.path("content").isTextual() ? delta.path("content").asText() : null;
        if (content != null && !content.isEmpty()) {
            text.append(content);
            listener.onText(content);
        }
        for (String key : new String[]{"reasoning_content", "reasoning"}) {
            if (delta.path(key).isTextual() && !delta.path(key).asText().isEmpty()) {
                reasoning.append(delta.path(key).asText());
                listener.onReasoning(delta.path(key).asText());
                break;
            }
        }
        JsonNode toolCalls = delta.path("tool_calls");
        if (toolCalls.isArray()) {
            for (JsonNode tc : toolCalls) {
                int index = tc.has("index") ? tc.path("index").asInt() : guessIndex(tc);
                Call call = callAt(index);
                boolean announce = false;
                if (tc.path("id").isTextual() && !tc.path("id").asText().isEmpty() && call.id.isEmpty()) {
                    call.id = tc.path("id").asText();
                }
                JsonNode fn = tc.path("function");
                if (fn.path("name").isTextual() && !fn.path("name").asText().isEmpty() && call.name.isEmpty()) {
                    call.name = fn.path("name").asText();
                    announce = true;
                }
                if (announce) {
                    listener.onToolStart(index, call.id, call.name);
                }
                if (fn.path("arguments").isTextual()) {
                    String frag = fn.path("arguments").asText();
                    if (!frag.isEmpty()) {
                        call.arguments.append(frag);
                        listener.onToolArgs(index, call.arguments.length());
                    }
                }
            }
        }
        if (choice.path("finish_reason").isTextual()) {
            finishReason = choice.path("finish_reason").asText();
        }
        JsonNode usage = root.path("usage");
        if (usage.isObject()) {
            if (usage.has("prompt_tokens")) promptTokens = usage.path("prompt_tokens").asInt();
            if (usage.has("completion_tokens")) completionTokens = usage.path("completion_tokens").asInt();
        }
    }

    /** 有的兼容实现不给 index：带了新 id 就是新的一个，否则续在最后一个上。 */
    private int guessIndex(JsonNode tc) {
        if (calls.isEmpty()) return 0;
        String id = tc.path("id").asText("");
        Call last = calls.get(calls.size() - 1);
        if (!id.isEmpty() && !last.id.isEmpty() && !id.equals(last.id)) {
            return calls.size();
        }
        return calls.size() - 1;
    }

    private Call callAt(int index) {
        while (calls.size() <= index) {
            calls.add(new Call());
        }
        return calls.get(index);
    }

    // ── Anthropic /v1/messages（stream=true） ────────────────────────────────

    public void onAnthropicEvent(JsonNode root) {
        if (root == null) return;
        String type = root.path("type").asText("");
        switch (type) {
            case "error" -> throw new BusinessException("模型返回错误：" + root.path("error").path("message").asText(root.toString()));
            case "message_start" -> {
                JsonNode usage = root.path("message").path("usage");
                if (usage.has("input_tokens")) promptTokens = usage.path("input_tokens").asInt();
            }
            case "content_block_start" -> {
                JsonNode block = root.path("content_block");
                if ("tool_use".equals(block.path("type").asText())) {
                    int ordinal = calls.size();
                    anthropicBlockToCall.put(root.path("index").asInt(), ordinal);
                    Call call = callAt(ordinal);
                    call.id = block.path("id").asText("");
                    call.name = block.path("name").asText("");
                    listener.onToolStart(ordinal, call.id, call.name);
                } else if ("text".equals(block.path("type").asText()) && !block.path("text").asText("").isEmpty()) {
                    text.append(block.path("text").asText());
                    listener.onText(block.path("text").asText());
                }
            }
            case "content_block_delta" -> {
                JsonNode delta = root.path("delta");
                switch (delta.path("type").asText("")) {
                    case "text_delta" -> {
                        String t = delta.path("text").asText("");
                        if (!t.isEmpty()) {
                            text.append(t);
                            listener.onText(t);
                        }
                    }
                    case "thinking_delta" -> {
                        String t = delta.path("thinking").asText("");
                        if (!t.isEmpty()) {
                            reasoning.append(t);
                            listener.onReasoning(t);
                        }
                    }
                    case "input_json_delta" -> {
                        Integer ordinal = anthropicBlockToCall.get(root.path("index").asInt());
                        String frag = delta.path("partial_json").asText("");
                        if (ordinal != null && !frag.isEmpty()) {
                            Call call = callAt(ordinal);
                            call.arguments.append(frag);
                            listener.onToolArgs(ordinal, call.arguments.length());
                        }
                    }
                    default -> { }
                }
            }
            case "message_delta" -> {
                String stop = root.path("delta").path("stop_reason").asText(null);
                if (stop != null) finishReason = AnthropicFormat.finishReason(stop);
                JsonNode usage = root.path("usage");
                if (usage.has("output_tokens")) completionTokens = usage.path("output_tokens").asInt();
            }
            default -> { }
        }
    }

    /** 不走工具协议的供应商（Gemini 等，只在没有工具时用）：正文原样累加。 */
    public void onPlainText(String delta) {
        if (delta != null && !delta.isEmpty()) {
            text.append(delta);
            listener.onText(delta);
        }
    }

    // ── 结果 ────────────────────────────────────────────────────────────────

    /** 拼好的助手消息，OpenAI 格式。没有名字的工具调用（流断在半截）不带出去。 */
    public Map<String, Object> message() {
        List<Map<String, Object>> out = new ArrayList<>();
        for (int i = 0; i < calls.size(); i++) {
            Call c = calls.get(i);
            if (c.name.isEmpty()) continue;
            String id = c.id.isEmpty() ? "call_" + i : c.id;
            // Anthropic 的无参工具调用不发 input_json_delta —— 参数是空对象，不是空字符串
            String args = c.arguments.length() == 0 ? "{}" : c.arguments.toString();
            out.add(AnthropicFormat.toolCall(id, c.name, args));
        }
        return AnthropicFormat.assistantMessage(text.toString(), out);
    }

    /**
     * stop / tool_calls / length。供应商没给的时候按有没有工具调用推断 ——
     * 而截断（length）只能由供应商说，推断不出来。
     */
    public String finishReason() {
        if (finishReason != null && !finishReason.isBlank()) return finishReason;
        return calls.stream().anyMatch(c -> !c.name.isEmpty()) ? "tool_calls" : "stop";
    }

    /** 供应商自己说了为什么停（而不是推断的）：流没有 [DONE] 时，有它也算说完了。 */
    public boolean providerSaidFinish() {
        return finishReason != null && !finishReason.isBlank();
    }

    public String text() {
        return text.toString();
    }

    public String reasoning() {
        return reasoning.toString();
    }

    public Integer promptTokens() {
        return promptTokens;
    }

    public Integer completionTokens() {
        return completionTokens;
    }

    /** 本轮输出了多少字（正文 + 工具参数）—— 供应商不报用量时用来估算。 */
    public int outputChars() {
        int n = text.length();
        for (Call c : calls) n += c.arguments.length() + c.name.length();
        return n;
    }
}
