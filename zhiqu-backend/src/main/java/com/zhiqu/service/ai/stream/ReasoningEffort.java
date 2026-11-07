package com.zhiqu.service.ai.stream;

import java.util.Locale;
import java.util.Map;

/**
 * 思考档位只有这一个出处（第一百零八轮）。用户 2026-11-07 定的五档：instant / medium / high / extra / max，
 * 网页和命令行同一套名字。里面存大写：OFF（instant）、MEDIUM、HIGH、EXTRA、MAX。
 * 老的 AUTO / DEEP 还认（缓存里的旧页面、库里的旧记录）。认不出的一律 OFF。
 *
 * <p>各家能力不一样，映射到它们自己的词：DeepSeek 只有 low / high / max（官方文档），所以 extra 和 high 一样；
 * OFF 在 DeepSeek 是 {@code thinking: disabled}；Claude Opus 5.5 的思考关不掉（发 disabled 是 400），OFF 就什么都不发，按模型自己的默认。
 */
public final class ReasoningEffort {
    public static final String OFF = "OFF";
    private static final Map<String, String> BY_NAME = Map.of(
            "MEDIUM", "MEDIUM", "HIGH", "HIGH", "EXTRA", "EXTRA", "MAX", "MAX",
            "AUTO", "MEDIUM", "DEEP", "HIGH");

    private ReasoningEffort() {}

    public static String normalize(Object raw) {
        String value = raw == null ? "" : String.valueOf(raw).trim().toUpperCase(Locale.ROOT);
        return BY_NAME.getOrDefault(value, OFF);
    }

    public static boolean on(String mode) {
        return !OFF.equals(normalize(mode));
    }

    /** 给命令行那份循环用的名字（网页代码模式把网页选的档位传给它）。 */
    public static String cliName(String mode) {
        String m = normalize(mode);
        return OFF.equals(m) ? "instant" : m.toLowerCase(Locale.ROOT);
    }

    static String forDeepSeek(String mode) {
        return switch (normalize(mode)) {
            case "MEDIUM" -> "low";
            case "MAX" -> "max";
            default -> "high";
        };
    }

    /** gpt-5、o 系最高到 xhigh；更新的有 max（Codex 文档：ultra / max / xhigh / high / medium / low，看模型）。 */
    static String forOpenAi(String modelName, String mode) {
        String name = modelName == null ? "" : modelName.toLowerCase(Locale.ROOT);
        return switch (normalize(mode)) {
            case "MEDIUM" -> "medium";
            case "EXTRA" -> "xhigh";
            case "MAX" -> name.matches("(?:.*/)?(?:o[134]|gpt-5).*") ? "xhigh" : "max";
            default -> "high";
        };
    }

    static String forAnthropic(String mode) {
        return switch (normalize(mode)) {
            case "MEDIUM" -> "medium";
            case "EXTRA" -> "xhigh";
            case "MAX" -> "max";
            default -> "high";
        };
    }

    /** claude-2 / claude-3 的 budget_tokens。 */
    static int anthropicLegacyBudget(String mode) {
        return switch (normalize(mode)) {
            case "MEDIUM" -> 1024;
            case "EXTRA" -> 4096;
            case "MAX" -> 8192;
            default -> 2048;
        };
    }

    /**
     * 这个模型能不能思考。不能的就当 instant 发（第一百零八轮之前是整个请求报错，换了模型的人还以为坏了）。
     * providerType 是归一化之后的（ModelProviderClient.normalizeProviderType）。
     */
    public static boolean supported(String capabilities, String modelName, String providerType) {
        String caps = capabilities == null ? "" : capabilities.toUpperCase(Locale.ROOT);
        String name = modelName == null ? "" : modelName.toLowerCase(Locale.ROOT);
        return caps.contains("REASONING")
                || caps.contains("THINKING")
                || name.contains("deepseek")
                || name.contains("reasoner")
                || name.contains("claude")
                || name.matches("(?:.*/)?(?:o[134]|gpt-[5-9]).*")
                || "ANTHROPIC".equals(providerType);
    }
}
