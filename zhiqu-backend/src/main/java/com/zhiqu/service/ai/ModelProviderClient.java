package com.zhiqu.service.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.AiModelConfig;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.client.RestTemplate;

import java.net.InetAddress;
import java.net.URI;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 「怎么跟模型供应商说话」这一层 —— 从 {@code AiServiceImpl} 里抽出来的第一刀。
 *
 * <h2>为什么是这一刀</h2>
 *
 * <p>{@code AiServiceImpl} 曾经有 5770 行，里面混着两类完全不同的东西：
 * <b>要问模型什么</b>（业务：排计划、读 Wiki、看代码）和<b>怎么把请求发出去</b>
 * （协议：URL 拼接、鉴权头、温度、超时、OpenAI 与 Anthropic 的差异、错误格式化）。
 * 后者是一整块自洽的东西，不依赖任何业务概念，也不会被业务改动波及 ——
 * 所以它先走，而且走了之后别的 agent 可以只依赖它，不必再依赖那个大类。
 *
 * <h2>这里面有一条安全边界</h2>
 *
 * <p>{@link #validateProviderRequestUrl} 是 SSRF 防护：不允许把模型 API 指向本机或内网，
 * 除非显式打开 {@code app.ai.allow-private-provider-url}（本地接假模型时才开）。
 * 它挡的是「用户把 API URL 填成 http://169.254.169.254/ 让服务器替他去读云元数据」。
 * 每一条出站请求都要先过它 —— 搬家时这一点没有变，调用点仍然在每个发请求的方法开头。
 *
 * <p>工具调用的限额（输出上限、读超时）由调用方按场景给出，见 {@link ToolTurnLimits}：
 * Wiki 与关键词触发的循环要快（4096 token / 25 秒），显式「代码」模式要能一次写出一整个文件。
 */
@Component
public class ModelProviderClient {

    /** 单次请求的输出上限。原来在 AiServiceImpl 里，两边都要用 —— 定义只留这一份。 */
    public static final int MODEL_MAX_TOKENS = 4096;

    private final ObjectMapper objectMapper;
    private final SensitiveCryptoService cryptoService;
    private final String anthropicVersion;
    private final String aiTemperature;
    private final boolean allowPrivateProviderUrl;
    /** 按读超时缓存的 RestTemplate —— 工具调用的超时随场景变，工厂本身很便宜，但没必要每次造。 */
    private final java.util.concurrent.ConcurrentHashMap<Integer, RestTemplate> toolTurnTemplates =
            new java.util.concurrent.ConcurrentHashMap<>();

    /**
     * 一次工具调用的限额：输出上限与读超时。
     *
     * <p>{@link #QUICK} 是原来唯一的一档（4096 token / 25 秒），给「查一下、读一页」这种快速轮次。
     * 2026-09-23 用户在命令行里让 coding agent 写一个马里奥小游戏：模型要在<b>一次</b>工具调用里写出
     * 整个 HTML，25 秒读超时把它掐断（日志里是 69 秒后的 I/O error），就算不超时，4096 token 也写不完
     * 一整个文件 —— 参数会被截成半截 JSON。显式「代码」模式因此要另一档，见 {@code CodeLoopBudget}。
     */
    public record ToolTurnLimits(int maxTokens, int readTimeoutMillis) {
        public static final ToolTurnLimits QUICK = new ToolTurnLimits(MODEL_MAX_TOKENS, 25_000);
    }

    /**
     * 模型这一轮的输出撞上了单次上限、被截断了。
     *
     * <p>2026-09-24 用户在命令行里做马里奥：模型想在一次工具调用里写完整个文件，输出超过上限被截断，
     * 截断的回复里没有完整的工具调用 —— 循环把它当成「模型说完了」<b>静默结束</b>，一个字的提示都没有。
     * 用户说「确认写入」，它再试、再被截断、再静默结束，最终回答每次把代码整份贴出来：看起来就是卡住了。
     * 抛这个异常而不是返回半截：调用方要把「被截断」告诉用户和模型，而不是当成正常结束。
     */
    public static final class ToolTurnTruncatedException extends RuntimeException {
        private final int maxTokens;

        public ToolTurnTruncatedException(int maxTokens) {
            super("模型输出超出单次上限（" + maxTokens + " token）被截断");
            this.maxTokens = maxTokens;
        }

        public int maxTokens() {
            return maxTokens;
        }
    }

    /**
     * 从 OpenAI 格式的响应里取出 {@code choices[0].message}；{@code finish_reason} 是 {@code length} 时抛
     * {@link ToolTurnTruncatedException}。纯函数 —— 判据直接喂响应 JSON。
     */
    static JsonNode openAiMessageOrTruncated(JsonNode root, int maxTokens) {
        if ("length".equals(root.at("/choices/0/finish_reason").asText(""))) {
            throw new ToolTurnTruncatedException(maxTokens);
        }
        JsonNode message = root.at("/choices/0/message");
        return message.isMissingNode() ? null : message;
    }

    /** Anthropic 版：{@code stop_reason} 是 {@code max_tokens} 时同样算截断。 */
    static JsonNode anthropicContentOrTruncated(JsonNode root, int maxTokens) {
        if ("max_tokens".equals(root.path("stop_reason").asText(""))) {
            throw new ToolTurnTruncatedException(maxTokens);
        }
        JsonNode content = root.path("content");
        return content.isMissingNode() ? null : content;
    }

    public ModelProviderClient(ObjectMapper objectMapper,
                               SensitiveCryptoService cryptoService,
                               @Value("${app.ai.anthropic-version:2023-06-01}") String anthropicVersion,
                               @Value("${app.ai.temperature:}") String aiTemperature,
                               @Value("${app.ai.allow-private-provider-url:false}") boolean allowPrivateProviderUrl) {
        this.objectMapper = objectMapper;
        this.cryptoService = cryptoService;
        this.anthropicVersion = anthropicVersion;
        this.aiTemperature = aiTemperature;
        this.allowPrivateProviderUrl = allowPrivateProviderUrl;
    }

    /** 与 {@code AiServiceImpl.hasText} 同义；这里用框架的那一份，不新造第二个定义。 */
    private static boolean hasText(String value) {
        return org.springframework.util.StringUtils.hasText(value);
    }

    public void validateProviderRequestUrl(String apiUrl) {
        if (!hasText(apiUrl)) {
            throw new BusinessException("AI API URL 不能为空");
        }
        URI uri;
        try {
            uri = URI.create(apiUrl.trim());
        } catch (Exception e) {
            throw new BusinessException("AI API URL 格式不正确");
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!Set.of("http", "https").contains(scheme)) {
            throw new BusinessException("AI API URL 只允许 http/https");
        }
        String host = uri.getHost();
        if (!hasText(host)) {
            throw new BusinessException("AI API URL 缺少主机名");
        }
        if (allowPrivateProviderUrl) {
            return;
        }
        if (isLocalHostName(host)) {
            throw new BusinessException("生产环境禁止把 AI API URL 指向本机或内网地址");
        }
        try {
            for (InetAddress address : InetAddress.getAllByName(host)) {
                if (isPrivateAddress(address)) {
                    throw new BusinessException("生产环境禁止把 AI API URL 指向本机或内网地址");
                }
            }
        } catch (BusinessException e) {
            throw e;
        } catch (Exception e) {
            throw new BusinessException("AI API URL 主机无法解析");
        }
    }

    public boolean isLocalHostName(String host) {
        String value = host == null ? "" : host.trim().toLowerCase(Locale.ROOT);
        return "localhost".equals(value) || value.endsWith(".localhost")
                || "0.0.0.0".equals(value) || "::1".equals(value);
    }

    public boolean isPrivateAddress(InetAddress address) {
        if (address.isAnyLocalAddress()
                || address.isLoopbackAddress()
                || address.isLinkLocalAddress()
                || address.isSiteLocalAddress()
                || address.isMulticastAddress()) {
            return true;
        }
        byte[] bytes = address.getAddress();
        if (bytes.length == 4) {
            int first = bytes[0] & 0xff;
            int second = bytes[1] & 0xff;
            return first == 10
                    || (first == 172 && second >= 16 && second <= 31)
                    || (first == 192 && second == 168)
                    || (first == 100 && second >= 64 && second <= 127)
                    || (first == 169 && second == 254);
        }
        if (bytes.length == 16) {
            int first = bytes[0] & 0xff;
            return (first & 0xfe) == 0xfc;
        }
        return false;
    }

    public String decryptedApiKey(AiModelConfig model) {
        if (model == null || !hasText(model.getEncryptedApiKey())) {
            return "";
        }
        return cryptoService.decrypt(model.getEncryptedApiKey());
    }

    /**
     * 按 app.ai.temperature 决定是否写入 temperature。
     * 留空 = 不发送——新一代模型（如 Claude fable / opus-4 系列）已废弃该参数，
     * 发送会报 400 "temperature is deprecated for this model"。
     */
    public void applyTemperature(Map<String, Object> body) {
        if (!hasText(aiTemperature)) {
            return;
        }
        try {
            body.put("temperature", Double.parseDouble(aiTemperature.trim()));
        } catch (NumberFormatException ignored) {
            // 配置非数字则视为不发送
        }
    }

    public HttpHeaders anthropicHeaders(AiModelConfig config) {
        String apiKey = decryptedApiKey(config);
        if (!hasText(apiKey)) {
            throw new BusinessException("Anthropic 模型缺少 API Key");
        }
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("x-api-key", apiKey);
        headers.set("anthropic-version", anthropicVersion);
        return headers;
    }

    public String normalizeProviderType(String value) {
        String type = hasText(value) ? value.trim().toUpperCase(Locale.ROOT) : "OPENAI_COMPATIBLE";
        if ("OPENAI".equals(type) || "DEEPSEEK".equals(type) || "QWEN".equals(type)) {
            return "OPENAI_COMPATIBLE";
        }
        if ("VLLM".equals(type)) {
            return "VLLM_OPENAI_COMPATIBLE";
        }
        if (!Set.of("OPENAI_COMPATIBLE", "ANTHROPIC", "OLLAMA", "VLLM_OPENAI_COMPATIBLE",
                "GEMINI", "SENSENOVA", "OPENAI_RESPONSES").contains(type)) {
            return "OPENAI_COMPATIBLE";
        }
        return type;
    }

    public boolean isAnthropicProvider(AiModelConfig config) {
        return "ANTHROPIC".equals(normalizeProviderType(config.getProviderType()));
    }

    /** 仅 OpenAI /chat/completions 协议且支持 tools 的提供方才启用工具调用（排除 Anthropic / Gemini / Responses 等异构协议）。 */
    public boolean supportsOpenAiToolCalling(AiModelConfig config) {
        String type = normalizeProviderType(config.getProviderType());
        return "OPENAI_COMPATIBLE".equals(type) || "VLLM_OPENAI_COMPATIBLE".equals(type);
    }

    /** 是否支持工具调用（OpenAI 兼容 + Anthropic 原生 tools）。 */
    public boolean supportsToolCalling(AiModelConfig config) {
        return supportsOpenAiToolCalling(config) || isAnthropicProvider(config);
    }

    /**
     * 把 OpenAI 工具定义 {type:function, function:{name,description,parameters}}
     * 转成 Anthropic 的 {name, description, input_schema}。
     */
    public List<Map<String, Object>> toAnthropicTools(List<Map<String, Object>> openAiTools) {
        List<Map<String, Object>> out = new ArrayList<>();
        if (openAiTools == null) {
            return out;
        }
        for (Map<String, Object> tool : openAiTools) {
            Object fn = tool.get("function");
            if (!(fn instanceof Map<?, ?> function)) {
                continue;
            }
            Map<String, Object> at = new LinkedHashMap<>();
            at.put("name", function.get("name"));
            Object desc = function.get("description");
            if (desc != null) {
                at.put("description", desc);
            }
            Object params = function.get("parameters");
            at.put("input_schema", params != null ? params : Map.of("type", "object", "properties", Map.of()));
            out.add(at);
        }
        return out;
    }

    /** 非流式发起一轮带工具的对话（tool_choice=auto），返回 choices[0].message 节点（含可能的 tool_calls）；无则 null。 */
    public JsonNode callOpenAiToolTurn(AiModelConfig config, List<Map<String, Object>> messages, List<Map<String, Object>> tools) {
        return callOpenAiToolTurn(config, messages, tools, ToolTurnLimits.QUICK);
    }

    /** 同上，按给定限额。 */
    public JsonNode callOpenAiToolTurn(AiModelConfig config, List<Map<String, Object>> messages,
                                       List<Map<String, Object>> tools, ToolTurnLimits limits) {
        validateProviderRequestUrl(config.getApiUrl());
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        String apiKey = decryptedApiKey(config);
        if (hasText(apiKey)) {
            headers.setBearerAuth(apiKey);
        }
        Map<String, Object> body = new HashMap<>();
        body.put("model", config.getModelName());
        body.put("messages", messages);
        applyTemperature(body);
        body.put("max_tokens", limits.maxTokens());
        body.put("tools", tools);
        body.put("tool_choice", "auto"); // 由模型自行决定调用哪个工具或直接作答
        try {
            HttpEntity<Map<String, Object>> request = new HttpEntity<>(body, headers);
            ResponseEntity<String> response = toolTurnTemplate(limits).postForEntity(
                    resolveChatCompletionsUrl(config.getApiUrl()), request, String.class);
            return openAiMessageOrTruncated(objectMapper.readTree(response.getBody()), limits.maxTokens());
        } catch (ToolTurnTruncatedException e) {
            throw e;   // 原样抛给调用方 —— 它要区分「被截断」和「调用失败」
        } catch (RestClientResponseException e) {
            throw new BusinessException(formatAiHttpError(e));
        } catch (Exception e) {
            // 原来写的是「Wiki 工具调用失败」—— code agent 也走这里，那条日志把人往 Wiki 那边引
            throw new BusinessException("工具调用失败：" + e.getMessage());
        }
    }

    /**
     * 不分供应商的一轮工具调用：进出都是 OpenAI 格式（{@code role=assistant + tool_calls}）。
     *
     * <p>Anthropic 配置原来被 {@link #supportsToolCalling} 标成支持工具调用，code agent 却把 OpenAI 格式的
     * 请求原样发给它 —— 那是 400。这里按供应商分派，翻译在 {@link AnthropicFormat} 一处（网关也用它）。
     */
    public JsonNode callToolTurn(AiModelConfig config, List<Map<String, Object>> messages,
                                 List<Map<String, Object>> tools, ToolTurnLimits limits) {
        if (isAnthropicProvider(config)) {
            AnthropicFormat.Request request = AnthropicFormat.fromOpenAi(messages, objectMapper);
            JsonNode content = callAnthropicToolTurn(config, request.system(), request.messages(),
                    toAnthropicTools(tools), limits);
            return content == null ? null : objectMapper.valueToTree(AnthropicFormat.toOpenAiMessage(content, objectMapper));
        }
        return callOpenAiToolTurn(config, messages, tools, limits);
    }

    /** 非流式发起一轮带工具的 Anthropic 对话（tool_choice=auto），返回 content 数组节点（含可能的 tool_use）；无则 null。 */
    public JsonNode callAnthropicToolTurn(AiModelConfig config, String system,
                                           List<Map<String, Object>> messages, List<Map<String, Object>> tools) {
        return callAnthropicToolTurn(config, system, messages, tools, ToolTurnLimits.QUICK);
    }

    /** 同上，按给定限额。 */
    public JsonNode callAnthropicToolTurn(AiModelConfig config, String system, List<Map<String, Object>> messages,
                                          List<Map<String, Object>> tools, ToolTurnLimits limits) {
        validateProviderRequestUrl(config.getApiUrl());
        HttpHeaders headers = anthropicHeaders(config);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", config.getModelName());
        body.put("max_tokens", limits.maxTokens());
        applyTemperature(body);
        if (hasText(system)) {
            body.put("system", system);
        }
        body.put("messages", messages);
        body.put("tools", tools);
        body.put("tool_choice", Map.of("type", "auto"));
        try {
            HttpEntity<Map<String, Object>> request = new HttpEntity<>(body, headers);
            ResponseEntity<String> response = toolTurnTemplate(limits).postForEntity(
                    resolveAnthropicMessagesUrl(config.getApiUrl()), request, String.class);
            return anthropicContentOrTruncated(objectMapper.readTree(response.getBody()), limits.maxTokens());
        } catch (ToolTurnTruncatedException e) {
            throw e;
        } catch (RestClientResponseException e) {
            throw new BusinessException(formatAiHttpError(e));
        } catch (Exception e) {
            throw new BusinessException("工具调用失败：" + e.getMessage());
        }
    }

    public String resolveChatCompletionsUrl(String apiUrl) {
        String url = hasText(apiUrl) ? apiUrl.trim() : "https://api.openai.com/v1/chat/completions";
        while (url.endsWith("/")) {
            url = url.substring(0, url.length() - 1);
        }
        if (url.endsWith("/chat/completions")) {
            return url;
        }
        if (url.contains("api.openai.com") && !url.endsWith("/v1")) {
            return url + "/v1/chat/completions";
        }
        return url + "/chat/completions";
    }

    public String resolveAnthropicMessagesUrl(String apiUrl) {
        String url = hasText(apiUrl) ? apiUrl.trim() : "https://api.anthropic.com/v1/messages";
        while (url.endsWith("/")) {
            url = url.substring(0, url.length() - 1);
        }
        if (url.endsWith("/v1/messages")) {
            return url;
        }
        if (url.endsWith("/v1")) {
            return url + "/messages";
        }
        return url + "/v1/messages";
    }

    public String formatAiHttpError(RestClientResponseException e) {
        String detail = extractAiErrorDetail(e.getResponseBodyAsString());
        return "AI 接口调用失败（HTTP " + e.getStatusCode().value() + "）：" + detail;
    }

    /** 工具调用用的 RestTemplate：连接 10 秒，读超时按限额。 */
    private RestTemplate toolTurnTemplate(ToolTurnLimits limits) {
        // 按 5 秒取整再当缓存键：调用方的超时是「剩余预算」算出来的，精确到毫秒、每次都不一样，
        // 直接当键的话这张表会无限长。取整后最多几十个，多等的不超过 5 秒。
        int key = (int) Math.max(5_000, ((limits.readTimeoutMillis() + 4_999L) / 5_000L) * 5_000L);
        return toolTurnTemplates.computeIfAbsent(key, timeout -> {
            SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
            factory.setConnectTimeout(10_000);
            factory.setReadTimeout(timeout);
            return new RestTemplate(factory);
        });
    }

    public String extractAiErrorDetail(String responseBody) {
        if (!hasText(responseBody)) {
            return "接口没有返回错误详情";
        }
        try {
            JsonNode root = objectMapper.readTree(responseBody);
            JsonNode error = root.get("error");
            if (error != null) {
                if (error.isTextual()) {
                    return com.zhiqu.common.Texts.limitCollapsed(error.asText(), 500);
                }
                JsonNode message = error.get("message");
                JsonNode code = error.get("code");
                JsonNode type = error.get("type");
                List<String> parts = new ArrayList<>();
                if (message != null && !message.isNull()) parts.add(message.asText());
                if (code != null && !code.isNull()) parts.add("code=" + code.asText());
                if (type != null && !type.isNull()) parts.add("type=" + type.asText());
                if (!parts.isEmpty()) {
                    return com.zhiqu.common.Texts.limitCollapsed(String.join("；", parts), 500);
                }
            }
        } catch (Exception ignored) {
            // Fall back to raw body below.
        }
        return com.zhiqu.common.Texts.limitCollapsed(responseBody, 500);
    }
}
