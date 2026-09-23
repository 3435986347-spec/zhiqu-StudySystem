package com.zhiqu.service.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 工具调用对话在 OpenAI 格式与 Anthropic 格式之间互转。纯函数，不碰网络。
 *
 * <p>仓库里的工具循环一律用 OpenAI 格式记对话（{@code role=assistant + tool_calls}、{@code role=tool}），
 * 这里是唯一把它翻成 Anthropic 那一套的地方。由来：计划里记的一个已知问题 —— Anthropic 配置被
 * {@code supportsToolCalling} 标成支持工具调用，code agent 却把 OpenAI 格式的请求原样发给它。
 * 网关（命令行）和 code agent 都走这里，不各写一份。
 *
 * <h2>Anthropic 那边的四条硬规矩（违反任何一条都是 400）</h2>
 * <ol>
 *   <li>system 不是一条消息，是请求顶层的一个字段。</li>
 *   <li>user / assistant 必须交替，第一条必须是 user。</li>
 *   <li>工具结果是 user 消息里的 {@code tool_result} 块，且必须紧跟在发出 {@code tool_use} 的那条 assistant 之后；
 *       一条 user 消息里 {@code tool_result} 要排在其它内容前面。</li>
 *   <li>content 不能是空的。</li>
 * </ol>
 */
public final class AnthropicFormat {

    private AnthropicFormat() {
    }

    public record Request(String system, List<Map<String, Object>> messages) {
    }

    public static Request fromOpenAi(List<Map<String, Object>> messages, ObjectMapper json) {
        StringBuilder system = new StringBuilder();
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> m : messages == null ? List.<Map<String, Object>>of() : messages) {
            String role = String.valueOf(m.get("role"));
            switch (role) {
                case "system" -> {
                    String text = textOf(m.get("content"));
                    if (!text.isBlank()) {
                        if (system.length() > 0) system.append("\n\n");
                        system.append(text);
                    }
                }
                case "assistant" -> append(out, "assistant", assistantBlocks(m, json));
                case "tool" -> {
                    Map<String, Object> block = new LinkedHashMap<>();
                    block.put("type", "tool_result");
                    block.put("tool_use_id", String.valueOf(m.get("tool_call_id")));
                    String content = textOf(m.get("content"));
                    block.put("content", content.isEmpty() ? "（空）" : content);
                    append(out, "user", new ArrayList<>(List.of(block)));
                }
                default -> {
                    String text = textOf(m.get("content"));
                    Map<String, Object> block = new LinkedHashMap<>();
                    block.put("type", "text");
                    block.put("text", text.isEmpty() ? "（空）" : text);
                    append(out, "user", new ArrayList<>(List.of(block)));
                }
            }
        }
        if (out.isEmpty() || !"user".equals(out.get(0).get("role"))) {
            // 规矩 2：裁剪之后开头可能是 assistant —— 补一条占位的 user，而不是丢掉那条 assistant
            Map<String, Object> first = new LinkedHashMap<>();
            first.put("role", "user");
            first.put("content", new ArrayList<>(List.of(Map.of("type", "text", "text", "（继续之前的对话）"))));
            out.add(0, first);
        }
        return new Request(system.toString(), out);
    }

    private static List<Object> assistantBlocks(Map<String, Object> m, ObjectMapper json) {
        List<Object> blocks = new ArrayList<>();
        String text = textOf(m.get("content"));
        if (!text.isBlank()) {
            blocks.add(new LinkedHashMap<>(Map.of("type", "text", "text", text)));
        }
        if (m.get("tool_calls") instanceof List<?> calls) {
            for (Object c : calls) {
                if (!(c instanceof Map<?, ?> call)) continue;
                Object fn = call.get("function");
                Map<?, ?> function = fn instanceof Map<?, ?> f ? f : Map.of();
                Map<String, Object> block = new LinkedHashMap<>();
                block.put("type", "tool_use");
                block.put("id", String.valueOf(call.get("id")));
                block.put("name", String.valueOf(function.get("name")));
                block.put("input", parseArguments(function.get("arguments"), json));
                blocks.add(block);
            }
        }
        if (blocks.isEmpty()) {
            blocks.add(new LinkedHashMap<>(Map.of("type", "text", "text", "（空）")));   // 规矩 4
        }
        return blocks;
    }

    /** 参数在 OpenAI 格式里是 JSON 字符串，Anthropic 要对象。解析不了（比如被截断的）就包一层原文。 */
    static Object parseArguments(Object arguments, ObjectMapper json) {
        if (arguments instanceof Map<?, ?> map) {
            return map;
        }
        String raw = arguments == null ? "" : String.valueOf(arguments);
        if (raw.isBlank()) {
            return new LinkedHashMap<>();
        }
        try {
            JsonNode node = json.readTree(raw);
            if (node != null && node.isObject()) {
                return json.convertValue(node, Map.class);
            }
        } catch (Exception ignored) {
            // 落到下面
        }
        return new LinkedHashMap<>(Map.of("_raw", raw));
    }

    /** 同角色相邻的合并成一条（规矩 2），tool_result 排在前面（规矩 3）。 */
    @SuppressWarnings("unchecked")
    private static void append(List<Map<String, Object>> out, String role, List<Object> blocks) {
        if (!out.isEmpty() && role.equals(out.get(out.size() - 1).get("role"))) {
            List<Object> existing = (List<Object>) out.get(out.size() - 1).get("content");
            existing.addAll(blocks);
            if ("user".equals(role)) {
                List<Object> results = new ArrayList<>();
                List<Object> others = new ArrayList<>();
                for (Object b : existing) {
                    if (b instanceof Map<?, ?> map && "tool_result".equals(map.get("type"))) results.add(b);
                    else others.add(b);
                }
                existing.clear();
                existing.addAll(results);
                existing.addAll(others);
            }
            return;
        }
        Map<String, Object> msg = new LinkedHashMap<>();
        msg.put("role", role);
        msg.put("content", blocks);
        out.add(msg);
    }

    static String textOf(Object content) {
        if (content == null) {
            return "";
        }
        if (content instanceof String s) {
            return s;
        }
        if (content instanceof List<?> parts) {
            StringBuilder sb = new StringBuilder();
            for (Object p : parts) {
                if (p instanceof Map<?, ?> part && part.get("text") != null) {
                    if (sb.length() > 0) sb.append('\n');
                    sb.append(part.get("text"));
                }
            }
            return sb.toString();
        }
        return String.valueOf(content);
    }

    /**
     * Anthropic 的 content 数组 → OpenAI 格式的助手消息（{@code content} + {@code tool_calls}）。
     * thinking 块不带回：它不是回答的一部分，而且回填时 Anthropic 要求原样带签名。
     */
    public static Map<String, Object> toOpenAiMessage(JsonNode content, ObjectMapper json) {
        StringBuilder text = new StringBuilder();
        List<Map<String, Object>> calls = new ArrayList<>();
        if (content != null && content.isArray()) {
            for (JsonNode block : content) {
                String type = block.path("type").asText("");
                if ("text".equals(type)) {
                    text.append(block.path("text").asText(""));
                } else if ("tool_use".equals(type)) {
                    calls.add(toolCall(block.path("id").asText(""), block.path("name").asText(""),
                            block.path("input").isMissingNode() ? "{}" : block.path("input").toString()));
                }
            }
        }
        return assistantMessage(text.toString(), calls);
    }

    public static Map<String, Object> toolCall(String id, String name, String arguments) {
        Map<String, Object> function = new LinkedHashMap<>();
        function.put("name", name);
        function.put("arguments", arguments);
        Map<String, Object> call = new LinkedHashMap<>();
        call.put("id", id);
        call.put("type", "function");
        call.put("function", function);
        return call;
    }

    public static Map<String, Object> assistantMessage(String text, List<Map<String, Object>> calls) {
        Map<String, Object> msg = new LinkedHashMap<>();
        msg.put("role", "assistant");
        msg.put("content", text);
        if (calls != null && !calls.isEmpty()) {
            msg.put("tool_calls", calls);
        }
        return msg;
    }

    /** Anthropic 的 stop_reason → OpenAI 的 finish_reason。 */
    public static String finishReason(String stopReason) {
        if (stopReason == null) return null;
        return switch (stopReason) {
            case "end_turn", "stop_sequence" -> "stop";
            case "tool_use" -> "tool_calls";
            case "max_tokens" -> "length";
            default -> stopReason;
        };
    }
}
