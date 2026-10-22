package com.zhiqu.service.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * code agent 工具循环里的对话预算（第十轮）。
 *
 * <p>原来没有上限：每读一个文件就多一整份内容，写草稿的调用参数里又带着整份文件，十轮下来几个中等文件就超过模型的窗口，
 * 供应商拒绝整个请求 —— 用户看到的是「工具循环中断」，前面读的、想的全白费。
 *
 * <p>超预算时按这个顺序腾地方，<b>结构不动</b>（调用与结果仍然成对，否则供应商同样拒绝）：
 * <ol>
 *   <li>旧的大段工具输出换成一句占位，<b>从最旧的开始</b>，腾够为止；最新的那一条永远原样（模型正要看它）——
 *       要用再读一遍，比整轮失败便宜。第一版是「最近 4 条原样」，扰动前的判据就红了：一次读能给到预算的一半，
 *       4 条原样本身就超预算，那道「上限」形同虚设；</li>
 *   <li>还不够，旧的助手消息里大段的调用参数（写草稿时的整份文件）换成只带 path 的小参数。</li>
 * </ol>
 * 系统提示、历史、用户这一轮的话一个字都不动。命令行那一侧同一件事在 {@code zhiqu-cli/src/compact.js}。
 */
public final class ToolLoopContext {

    static final int LARGE_TOOL_OUTPUT = 2_000;
    static final int LARGE_ARGUMENTS = 4_000;

    private ToolLoopContext() {
    }

    /** 这段对话现在有多少字（正文 + 调用参数）。 */
    static int size(List<Map<String, Object>> messages) {
        int total = 0;
        for (Map<String, Object> m : messages) {
            Object content = m.get("content");
            total += content == null ? 0 : String.valueOf(content).length();
            if (m.get("tool_calls") instanceof List<?> calls) {
                for (Object call : calls) {
                    if (call instanceof Map<?, ?> c && c.get("function") instanceof Map<?, ?> f && f.get("arguments") != null) {
                        total += String.valueOf(f.get("arguments")).length();
                    }
                }
            }
        }
        return total;
    }

    /** 就地腾到预算以内（腾不下就腾到能腾的程度）；返回省略了几处。 */
    @SuppressWarnings("unchecked")
    public static int fit(List<Map<String, Object>> messages, int budgetChars, ObjectMapper json) {
        int elided = 0;
        if (size(messages) <= budgetChars) {
            return 0;
        }
        List<Integer> toolAt = new ArrayList<>();
        for (int i = 0; i < messages.size(); i++) {
            if ("tool".equals(messages.get(i).get("role"))) {
                toolAt.add(i);
            }
        }
        int protectFrom = Math.max(0, toolAt.size() - 1);   // 最新的那一条不动
        for (int k = 0; k < protectFrom && size(messages) > budgetChars; k++) {
            Map<String, Object> m = messages.get(toolAt.get(k));
            String content = String.valueOf(m.get("content"));
            if (content.length() <= LARGE_TOOL_OUTPUT) {
                continue;
            }
            Map<String, Object> copy = new LinkedHashMap<>(m);
            copy.put("content", "（较早的工具输出已省略，原来 " + content.length() + " 字；需要的话请重新读取或重新运行）");
            messages.set(toolAt.get(k), copy);
            elided++;
        }
        // 最后一条助手消息不动：它的调用结果还在后面，参数是这一轮正要用的
        int lastAssistant = -1;
        for (int i = messages.size() - 1; i >= 0; i--) {
            if ("assistant".equals(messages.get(i).get("role"))) {
                lastAssistant = i;
                break;
            }
        }
        for (int i = 0; i < messages.size() && size(messages) > budgetChars; i++) {
            Map<String, Object> m = messages.get(i);
            if (i == lastAssistant || !(m.get("tool_calls") instanceof List<?> calls)) {
                continue;
            }
            List<Object> slim = new ArrayList<>();
            boolean changed = false;
            for (Object call : calls) {
                if (call instanceof Map<?, ?> c && c.get("function") instanceof Map<?, ?> f
                        && String.valueOf(f.get("arguments")).length() > LARGE_ARGUMENTS) {
                    Map<String, Object> fn = new LinkedHashMap<>((Map<String, Object>) f);
                    fn.put("arguments", slimArguments(String.valueOf(f.get("arguments")), json));
                    Map<String, Object> copy = new LinkedHashMap<>((Map<String, Object>) c);
                    copy.put("function", fn);
                    slim.add(copy);
                    changed = true;
                    elided++;
                } else {
                    slim.add(call);
                }
            }
            if (changed) {
                Map<String, Object> copy = new LinkedHashMap<>(m);
                copy.put("tool_calls", slim);
                messages.set(i, copy);
            }
        }
        return elided;
    }

    /** 大参数换成一个小而合法的 JSON：只留 path（给模型一个线索），并说明省略了。 */
    private static String slimArguments(String raw, ObjectMapper json) {
        Map<String, Object> slim = new LinkedHashMap<>();
        try {
            JsonNode node = json.readTree(raw);
            if (node.hasNonNull("path")) {
                slim.put("path", node.get("path").asText());
            }
        } catch (Exception ignored) {
            // 参数本来就不是合法 JSON：只留说明
        }
        slim.put("_省略", "这次调用的大段参数已省略（原来 " + raw.length() + " 字）");
        try {
            return json.writeValueAsString(slim);
        } catch (Exception e) {
            return "{}";
        }
    }
}
