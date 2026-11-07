package com.zhiqu.service.harness;

import com.zhiqu.service.ai.stream.ReasoningEffort;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 命令行的思考档位和思考内容的回传（第一百零八轮，Codex 同级第 1 步，{@code docs/codex-parity-plan.md}）。
 *
 * <p>命令行的消息里带着三个字段，只有网关认识，发给供应商之前一定要过这里：
 * <ul>
 *   <li>{@code reasoning_content}：OpenAI 兼容协议里的思考原文。DeepSeek 开着思考、请求带工具时，
 *       之前每一轮都要原样传回去，缺了直接 400（官方文档：Thinking Mode）。关着档位时生成的旧消息补空串。</li>
 *   <li>{@code reasoning_blocks}：Anthropic 的思考块，带签名，要原样回放（改一个字就失效）。</li>
 *   <li>{@code reasoning_model}：这段思考是哪个模型想的。换了模型不回放：别的模型读不了，还可能 400。</li>
 * </ul>
 * 别的供应商一个字段都见不到 —— 不认识的字段有的会报错。
 */
final class ReasoningHistory {
    static final String CONTENT = "reasoning_content";
    static final String BLOCKS = "reasoning_blocks";
    static final String MODEL = "reasoning_model";
    static final String OFF = ReasoningEffort.OFF;

    private ReasoningHistory() {}

    /** 请求没说就用服务端的默认；说了认不出就当 instant（不把请求弄坏）。 */
    static String resolve(Object requested, String fallback) {
        return requested == null ? fallback : ReasoningEffort.normalize(requested);
    }

    /**
     * 开着思考时输出上限翻倍（窗口允许的话）：思考也算在上限里，第五十四轮 DeepSeek 想完 4096 就没地方写回答了。
     * 16384 全想完，工具调用的参数就被截断。
     */
    static int outputLimit(int requested, String effort, int cap, int window) {
        if (OFF.equals(effort)) return requested;
        return Math.max(requested, Math.min(Math.min(requested * 2, cap), window / 2));
    }

    /** DeepSeek 开着思考、带工具：之前每一轮都要有 reasoning_content。 */
    static boolean mustEcho(String modelName, String effort) {
        return !OFF.equals(effort) && modelName != null && modelName.toLowerCase(Locale.ROOT).contains("deepseek");
    }

    /**
     * 发给 OpenAI 兼容供应商的消息。echo = true 时每条助手消息都带 reasoning_content（是这个模型想的就给原文，
     * 否则给空串）；false 时三个字段都去掉。
     */
    static List<Map<String, Object>> forOpenAi(List<Map<String, Object>> messages, String modelName, boolean echo) {
        List<Map<String, Object>> out = new ArrayList<>(messages.size());
        for (Map<String, Object> m : messages) {
            if (!m.containsKey(CONTENT) && !m.containsKey(BLOCKS) && !m.containsKey(MODEL)
                    && !(echo && "assistant".equals(m.get("role")))) {
                out.add(m);
                continue;
            }
            Map<String, Object> copy = new LinkedHashMap<>(m);
            Object text = copy.remove(CONTENT);
            copy.remove(BLOCKS);
            Object model = copy.remove(MODEL);
            if (echo && "assistant".equals(m.get("role"))) {
                copy.put(CONTENT, text != null && String.valueOf(model).equals(modelName) ? text : "");
            }
            out.add(copy);
        }
        return out;
    }

    /** 发给 Anthropic 的消息：思考块只回放给想出它的那个模型；replay = false 时都去掉。 */
    static List<Map<String, Object>> forAnthropic(List<Map<String, Object>> messages, String modelName, boolean replay) {
        List<Map<String, Object>> out = new ArrayList<>(messages.size());
        for (Map<String, Object> m : messages) {
            if (!m.containsKey(CONTENT) && !m.containsKey(BLOCKS) && !m.containsKey(MODEL)) {
                out.add(m);
                continue;
            }
            Map<String, Object> copy = new LinkedHashMap<>(m);
            copy.remove(CONTENT);
            Object model = copy.remove(MODEL);
            if (!replay || !String.valueOf(model).equals(modelName)) copy.remove(BLOCKS);
            out.add(copy);
        }
        return out;
    }

    /** 这次请求里真的有要回放的东西吗（有才值得「去掉回放重试」）。 */
    static boolean hasReplay(List<Map<String, Object>> messages, String modelName) {
        for (Map<String, Object> m : messages) {
            if (String.valueOf(m.get(MODEL)).equals(modelName)
                    && (m.get(BLOCKS) instanceof List<?> blocks && !blocks.isEmpty())) {
                return true;
            }
        }
        return false;
    }

    /** 这个 400 / 422 是不是在说思考相关的参数或回放（供应商不认、历史改过、签名失效）。 */
    static boolean rejected(int status, String body) {
        if (status != 400 && status != 422) return false;
        String text = body == null ? "" : body.toLowerCase(Locale.ROOT);
        return text.contains("reasoning") || text.contains("thinking") || text.contains("output_config") || text.contains("effort");
    }

    /** 拼好的助手消息挂上这一轮的思考，命令行原样记着、下一轮带回来。 */
    static Map<String, Object> attach(Map<String, Object> message, String text, List<Map<String, Object>> blocks, String modelName) {
        boolean hasText = text != null && !text.isEmpty();
        boolean hasBlocks = blocks != null && !blocks.isEmpty();
        if (!hasText && !hasBlocks) return message;
        Map<String, Object> out = new LinkedHashMap<>(message);
        if (hasBlocks) out.put(BLOCKS, blocks);
        else out.put(CONTENT, text);
        out.put(MODEL, String.valueOf(modelName));
        return out;
    }
}
