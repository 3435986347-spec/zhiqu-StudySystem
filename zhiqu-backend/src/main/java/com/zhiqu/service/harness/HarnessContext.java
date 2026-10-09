package com.zhiqu.service.harness;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 网关这一侧的上下文窗口：估算 token、超了就裁。
 *
 * <p>主要的压缩在命令行那一侧做（P6：用到约 80% 时把早先的对话压成摘要）。这里是<b>最后一道</b>：
 * 客户端版本旧、估算偏小、或者一轮里工具输出特别大的时候，宁可裁掉最早的几轮再发，也不要让供应商
 * 回一个「超出上下文长度」的 400 —— 那样这一轮什么都得不到。裁了多少会在 {@code start} 事件里告诉客户端。
 *
 * <h2>怎么裁才不会把对话弄坏</h2>
 *
 * <p>工具调用是成对的：一条带 {@code tool_calls} 的 assistant 后面跟着对应的 {@code tool} 结果。
 * 只丢掉前者、留着后者，OpenAI 和 Anthropic 都会直接拒绝。所以按「一轮」丢 —— 从一条 user 消息开始，
 * 到下一条 user 消息之前，整组一起走。system 消息与最新那一轮永远留着。
 * 最新一轮自己就超了（一轮里读了十几个大文件），再把这一轮里较早的工具输出换成一句占位 ——
 * 结构不动，只是内容变短。
 */
public final class HarnessContext {

    /** 模型没填上下文窗口时按这个算。和网页一样保守：填了才放开。 */
    public static final int DEFAULT_WINDOW = 64_000;
    /** 估算有误差，留一点余量给它。 */
    static final int SAFETY_TOKENS = 1_024;
    /** 最新一轮里，最近这几条工具输出无论如何保留原文。 */
    static final int KEEP_RECENT_TOOL_OUTPUTS = 4;
    public static final String ELIDED = "（这段较早的工具输出已省略，以免超出模型的上下文窗口；需要的话请重新读取）";

    private HarnessContext() {
    }

    public static int effectiveWindow(Integer configured) {
        return configured == null || configured <= 0 ? DEFAULT_WINDOW : configured;
    }

    /**
     * 粗估 token：中日韩字符大约一字一个，其余大约四个字符一个。偏高一点没关系（多裁一点），
     * 偏低才危险 —— 所以英文按 3.5 而不是 4。
     */
    public static int estimateTokens(String text) {
        if (text == null || text.isEmpty()) return 0;
        int cjk = 0;
        int other = 0;
        for (int i = 0; i < text.length(); ) {
            int cp = text.codePointAt(i);
            if ((cp >= 0x2E80 && cp <= 0x9FFF) || (cp >= 0xAC00 && cp <= 0xD7AF) || (cp >= 0xF900 && cp <= 0xFAFF)
                    || (cp >= 0xFF00 && cp <= 0xFFEF) || (cp >= 0x20000 && cp <= 0x3FFFF)) {
                cjk++;
            } else {
                other++;
            }
            i += Character.charCount(cp);
        }
        return cjk + (int) Math.ceil(other / 3.5);
    }

    public static int estimateMessage(Map<String, Object> m) {
        int n = 4;   // 角色与分隔符
        Object content = m.get("content");
        n += estimateTokens(content == null ? "" : content instanceof String s ? s : String.valueOf(content));
        Object calls = m.get("tool_calls");
        if (calls != null) {
            n += estimateTokens(String.valueOf(calls));
        }
        return n;
    }

    public static int estimateMessages(List<Map<String, Object>> messages) {
        int n = 0;
        for (Map<String, Object> m : messages) n += estimateMessage(m);
        return n;
    }

    public record Trimmed(List<Map<String, Object>> messages, int droppedMessages, int elidedToolOutputs, int estimatedTokens) {
    }

    public static Trimmed trim(List<Map<String, Object>> messages, int budgetTokens) {
        List<Map<String, Object>> system = new ArrayList<>();
        List<List<Map<String, Object>>> groups = new ArrayList<>();
        for (Map<String, Object> m : messages) {
            String role = String.valueOf(m.get("role"));
            if ("system".equals(role)) {
                system.add(m);
                continue;
            }
            if ("user".equals(role) || groups.isEmpty()) {
                groups.add(new ArrayList<>());
            }
            groups.get(groups.size() - 1).add(m);
        }
        int total = estimateMessages(messages);
        int dropped = 0;
        while (total > budgetTokens && groups.size() > 1) {
            List<Map<String, Object>> oldest = groups.remove(0);
            total -= estimateMessages(oldest);
            dropped += oldest.size();
        }
        int elided = 0;
        if (total > budgetTokens && !groups.isEmpty()) {
            List<Map<String, Object>> last = groups.get(groups.size() - 1);
            List<Integer> toolAt = new ArrayList<>();
            for (int i = 0; i < last.size(); i++) {
                if ("tool".equals(String.valueOf(last.get(i).get("role")))) toolAt.add(i);
            }
            for (int k = 0; k < toolAt.size() - KEEP_RECENT_TOOL_OUTPUTS && total > budgetTokens; k++) {
                int i = toolAt.get(k);
                Map<String, Object> original = last.get(i);
                Map<String, Object> shortened = new LinkedHashMap<>(original);
                shortened.put("content", ELIDED);
                total += estimateMessage(shortened) - estimateMessage(original);
                last.set(i, shortened);
                elided++;
            }
        }
        List<Map<String, Object>> out = new ArrayList<>(system);
        for (List<Map<String, Object>> g : groups) out.addAll(g);
        return new Trimmed(out, dropped, elided, total);
    }
}
