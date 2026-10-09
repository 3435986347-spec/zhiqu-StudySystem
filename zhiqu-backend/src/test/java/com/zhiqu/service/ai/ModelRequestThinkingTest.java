package com.zhiqu.service.ai;

import com.zhiqu.SourceText;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 第五十四轮：每一个发给模型的请求都要说清楚「思考不思考」。
 *
 * <p>DeepSeek 不说就默认想。用户 2026-10-09：「每次在 desktop app 里面都要等待好几分钟，在 cli 里面就很快」—— 同一个 deepseek-v4-pro，
 * 命令行一直明说不要思考，网页的 code agent 工具轮、拆计划、看图三处什么都没说（网页其余的调用早就说了）。
 * 发请求的地方有十几处，新加一处时最容易漏的就是这一句 —— 这里把它们全数出来：OpenAI 兼容的每一处都要调
 * {@code applyOpenAiReasoningOptions}；多出一处没归类的，这条红，逼着人决定它属于哪一类。
 * 各处发出去的到底是什么，ModelProviderToolTurnTest / AnswerOutputLimitTest 用真的 HTTP 看。
 */
class ModelRequestThinkingTest {

    /** 每一处 body.put("model", …) 所在的方法 → 它是哪一类 */
    private static final Map<String, String> KNOWN = new TreeMap<>(Map.ofEntries(
            Map.entry("impl/AiServiceImpl#callStudyPlanToolCall", "openai"),
            Map.entry("impl/AiServiceImpl#callStudyPlanToolCallAnthropic", "anthropic"),
            Map.entry("impl/AiServiceImpl#callOpenAiCompatibleApi", "openai"),
            Map.entry("impl/AiServiceImpl#callAiApiWithVision", "openai"),
            Map.entry("impl/AiServiceImpl#callAnthropicVisionApi", "anthropic"),
            Map.entry("impl/AiServiceImpl#anthropicBody", "anthropic"),
            Map.entry("harness/HarnessModelGateway#streamOpenAi", "openai"),
            Map.entry("harness/HarnessModelGateway#streamAnthropic", "anthropic"),
            Map.entry("ai/ModelProviderClient#callOpenAiToolTurn", "openai"),
            Map.entry("ai/ModelProviderClient#callAnthropicToolTurn", "anthropic"),
            // OpenAI 官方的 Responses 接口：只有要了深度思考才带 reasoning，没有 DeepSeek 那种「不说就想」
            Map.entry("stream/OpenAiResponsesAdapter#stream", "responses"),
            Map.entry("stream/OpenAiChatCompatibleAdapter#stream", "openai"),
            Map.entry("stream/AnthropicMessagesAdapter#anthropicBody", "anthropic")));

    private static final Path SERVICE = Path.of("src/main/java/com/zhiqu/service");
    private static final Pattern METHOD = Pattern.compile("(?m)^\\s+(?:public |private |protected |static |final |synchronized )*[\\w<>\\[\\], ?]+\\s+(\\w+)\\([^;]*$");

    @Test
    @DisplayName("发给模型的每一处都归了类；OpenAI 兼容的每一处都说了思考不思考（DeepSeek 不说就默认想）")
    void 每一处都说了() throws IOException {
        Map<String, String> found = new TreeMap<>();
        List<String> silent = new ArrayList<>();
        try (Stream<Path> walk = Files.walk(SERVICE)) {
            for (Path f : walk.filter(p -> p.toString().endsWith(".java")).toList()) {
                String code = SourceText.stripComments(Files.readString(f, StandardCharsets.UTF_8));
                Matcher put = Pattern.compile("body\\.put\\(\"model\", ").matcher(code);
                while (put.find()) {
                    String method = enclosingMethod(code, put.start());
                    String key = f.getParent().getFileName() + "/" + f.getFileName().toString().replace(".java", "") + "#" + method;
                    found.put(key, KNOWN.getOrDefault(key, "?"));
                    if ("openai".equals(KNOWN.get(key)) && !methodBody(code, put.start()).contains("applyOpenAiReasoningOptions(")) {
                        silent.add(key);
                    }
                }
            }
        }
        assertTrue(found.size() >= 13, "只扫到 " + found.size() + " 处 —— 扫空了？");
        assertEquals(KNOWN, found, "发给模型的地方变了：新的一处要归类（openai / anthropic / responses），OpenAI 兼容的要说思考不思考");
        assertEquals(List.of(), silent, "这几处 OpenAI 兼容的请求没说思考不思考 —— DeepSeek 会默认想，慢好几倍");
    }

    @Test
    @DisplayName("按下「代码」时不做检索改写（第五十四轮）：那是一整次模型往返，排在写回答前面，而写代码本来就不是在资料里找东西")
    void 代码模式不改写检索() throws IOException {
        String code = SourceText.stripComments(Files.readString(SERVICE.resolve("impl/AiServiceImpl.java"), StandardCharsets.UTF_8));
        int rewrite = code.indexOf("String rewritten = rewriteRetrievalQuery(s.config, s.limitedMessage);");
        assertTrue(rewrite > 0, "找不到检索改写那一处");
        String guard = code.substring(code.lastIndexOf("\n", code.lastIndexOf("if (", rewrite)), rewrite);
        assertTrue(guard.contains("if (s.notebookContextRows.isEmpty() && !AgentPlanDecision.codeModeRequested(s.contextOptions)) {"),
                "检索改写前面没有挡住「代码」模式：\n" + guard);
    }

    /** at 之前最近的一个方法签名的名字 */
    private static String enclosingMethod(String code, int at) {
        Matcher m = METHOD.matcher(code.substring(0, at));
        String name = "?";
        while (m.find()) {
            if (!List.of("if", "for", "while", "switch", "catch", "return", "new").contains(m.group(1))) name = m.group(1);
        }
        return name;
    }

    /** 从 at 往前找到方法签名、按花括号配对截出整个方法 */
    private static String methodBody(String code, int at) {
        Matcher m = METHOD.matcher(code.substring(0, at));
        int start = 0;
        while (m.find()) {
            if (!List.of("if", "for", "while", "switch", "catch", "return", "new").contains(m.group(1))) start = m.start();
        }
        int open = code.indexOf('{', start), depth = 0;
        for (int i = open; i < code.length(); i++) {
            char c = code.charAt(i);
            if (c == '{') depth++;
            else if (c == '}' && --depth == 0) return code.substring(start, i + 1);
        }
        return code.substring(start);
    }
}
