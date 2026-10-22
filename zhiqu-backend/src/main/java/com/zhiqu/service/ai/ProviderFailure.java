package com.zhiqu.service.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.net.ConnectException;
import java.net.HttpRetryException;
import java.net.NoRouteToHostException;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * 模型供应商那一侧出了问题时，用户看到的那句话（第十九轮）。
 *
 * <p>原来是把供应商的原文和 Java 的异常原文拼起来给用户：key 错了是「AI 接口调用失败：AI 接口调用失败」（401 的响应体读不到，
 * 原因整个丢了）；502 是一整页 nginx 的 HTML；连不上是 {@code I/O error on POST request for "http://…": Connection refused}
 * —— 接口地址、Jackson 的解析位置一起漏给用户。这里按<b>状态码 / 异常种类</b>说一句能看懂、知道下一步做什么的话，
 * 供应商给的原因（去掉 HTML、遮住 key）附在后面。网页聊天、测试连接、命令行网关共用这一份。
 */
public final class ProviderFailure {

    private ProviderFailure() {
    }

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final int DETAIL_MAX = 300;
    /**
     * 常见的密钥形状：供应商回显 key 时不能原样给到页面上（系统模型的 key 是管理员的，看报错的是普通用户）。
     * 要求带分隔符和数字：「skeleton_structure_description」这种普通词不能被当成 key 遮掉。
     */
    private static final Pattern KEY_SHAPES = Pattern.compile(
            "\\b(?:(?:sk|zqp|tvly|gsk|xai)[-_](?=[A-Za-z0-9_\\-]*\\d)[A-Za-z0-9_\\-]{12,}|AIza[0-9A-Za-z_\\-]{30,})");
    private static final Pattern BEARER = Pattern.compile("(?i)(bearer\\s+)[A-Za-z0-9._\\-]{8,}");

    /** 供应商回了一个 HTTP 错误。 */
    public static String http(int status, String body, String retryAfter, String apiKey) {
        String detail = detail(body, apiKey);
        String head = switch (status) {
            case 400 -> "模型拒绝了这次请求（HTTP 400）";
            case 401 -> "API Key 不对或已经失效（HTTP 401）：去「模型设置」里检查这个模型的 Key";
            case 402 -> "模型账户余额不足（HTTP 402）：充值之后再试";
            case 403 -> "这个 Key 没有权限用这个模型（HTTP 403）：检查 Key 的权限，或者换一个模型";
            case 404 -> "找不到这个接口或模型（HTTP 404）：检查「接口地址」和「模型名」";
            case 408, 504, 524 -> "模型服务处理超时（HTTP " + status + "），稍后再试";
            case 413 -> "发给模型的内容太长了（HTTP 413）：少附一些资料，或者开一段新对话";
            case 429 -> "模型供应商限流了（HTTP 429），" + retryHint(retryAfter);
            default -> status >= 500
                    ? "模型服务暂时出错了（HTTP " + status + "），稍后再试"
                    : "模型接口调用失败（HTTP " + status + "）";
        };
        return detail.isEmpty() ? head : head + "。供应商说：" + detail;
    }

    /** 流里来了一条 error 事件（开始回答之后才出错）。 */
    public static String inStream(JsonNode event, String apiKey) {
        String detail = detail(event == null ? "" : event.toString(), apiKey);
        return "模型在回答途中报错了" + (detail.isEmpty() ? "" : "：" + detail);
    }

    /** 连不上、读超时、连接断开、回的数据不是 JSON。不带接口地址、不带 Java 异常原文。 */
    public static String io(Throwable e, int readTimeoutSeconds) {
        Throwable root = e;
        for (Throwable t = e; t != null; t = t.getCause()) {
            root = t;
            if (t instanceof HttpRetryException retry && retry.responseCode() == 401) {
                return http(401, "", null, null);
            }
            if (t instanceof UnknownHostException) {
                return "找不到模型服务的地址（域名解析不了）：检查「接口地址」有没有写错，或者网络是不是断了";
            }
            if (t instanceof ConnectException || t instanceof NoRouteToHostException) {
                String m = lower(t.getMessage());
                if (m.contains("timed out")) {
                    return "连接模型服务超时：检查网络，或者「接口地址」能不能从这台服务器访问";
                }
                return "连不上模型服务（连接被拒绝）：检查「接口地址」，或者模型服务是不是没开";
            }
            if (t instanceof SocketTimeoutException) {
                String m = lower(t.getMessage());
                if (m.contains("connect")) {
                    return "连接模型服务超时：检查网络，或者「接口地址」能不能从这台服务器访问";
                }
                return (readTimeoutSeconds > 0 ? "模型服务 " + readTimeoutSeconds + " 秒没有任何输出" : "模型服务太久没有响应")
                        + "，已经放弃：它可能卡住了，稍后再试";
            }
            if (t instanceof javax.net.ssl.SSLException) {
                return "和模型服务的 HTTPS 连接建立不起来：检查「接口地址」是不是 https、证书是否有效";
            }
            if (t instanceof com.fasterxml.jackson.core.JsonProcessingException) {
                return "模型返回的数据格式不对（流里有一段不是合法的 JSON），这次回答没能收完";
            }
        }
        if (root instanceof SocketException || root instanceof java.io.EOFException || cutMidway(root)) {
            return "和模型服务的连接中途断开了，回答没说完";
        }
        return "和模型服务通信失败";
    }

    /**
     * 供应商的进程在回答途中没了、代理把连接掐了：JDK 报的不是 SocketException，而是分块读到一半的
     * {@code IOException("Premature EOF")}（浏览器里实测出来的 —— 假供应商好好收尾的话看不到这一种）。
     */
    private static boolean cutMidway(Throwable t) {
        if (!(t instanceof java.io.IOException)) {
            return false;
        }
        String m = lower(t.getMessage());
        return m.contains("premature eof") || m.contains("unexpected end of") || m.contains("missing crlf")
                || m.contains("connection reset") || m.contains("broken pipe");
    }

    /** 这种失败值不值得原样再试一次（命令行网关据此决定要不要自动重试）。 */
    public static boolean retryable(int status) {
        return status == 408 || status == 429 || status >= 500;
    }

    public static boolean retryableIo(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof UnknownHostException || t instanceof javax.net.ssl.SSLException
                    || t instanceof com.fasterxml.jackson.core.JsonProcessingException) {
                return false;
            }
            if (t instanceof HttpRetryException) {
                return false;
            }
        }
        return true;
    }

    /** 供应商给的原因：JSON 取 message，HTML 不要，遮住 key，最多 300 字。 */
    public static String detail(String body, String apiKey) {
        if (body == null || body.isBlank()) {
            return "";
        }
        String text = body.trim();
        if (text.startsWith("{")) {
            try {
                JsonNode root = JSON.readTree(text);
                String picked = firstText(root.at("/error/message"), root.path("error"), root.path("message"),
                        root.path("detail"), root.at("/error/type"));
                text = picked;
            } catch (Exception ignored) {
                // 不是合法 JSON：当普通文本处理
            }
        }
        String probe = text.toLowerCase(Locale.ROOT);
        if (probe.startsWith("<") || probe.contains("<html") || probe.contains("<!doctype")) {
            return "";
        }
        String collapsed = redact(text.replaceAll("\\s+", " ").trim(), apiKey);
        return collapsed.length() > DETAIL_MAX ? collapsed.substring(0, DETAIL_MAX) + "…" : collapsed;
    }

    /** 把 key（配置里的那一把，以及长得像 key 的）换成只留末四位的形状。 */
    public static String redact(String text, String apiKey) {
        if (text == null || text.isEmpty()) {
            return text == null ? "" : text;
        }
        String out = text;
        if (apiKey != null && apiKey.length() >= 6) {
            out = out.replace(apiKey, mask(apiKey));
        }
        out = BEARER.matcher(out).replaceAll("$1****");
        return KEY_SHAPES.matcher(out).replaceAll(m -> java.util.regex.Matcher.quoteReplacement(mask(m.group())));
    }

    private static String mask(String secret) {
        return secret.length() >= 12 ? "****" + secret.substring(secret.length() - 4) : "****";
    }

    private static String retryHint(String retryAfter) {
        if (retryAfter != null) {
            try {
                long seconds = Long.parseLong(retryAfter.trim());
                if (seconds > 0 && seconds <= 3600) {
                    return seconds + " 秒之后再试";
                }
            } catch (NumberFormatException ignored) {
                // HTTP 日期格式的 Retry-After：不去解析，照一般情况说
            }
        }
        return "等一会儿再试";
    }

    private static String firstText(JsonNode... nodes) {
        for (JsonNode node : nodes) {
            if (node != null && node.isTextual() && !node.asText().isBlank()) {
                return node.asText();
            }
        }
        return "";
    }

    private static String lower(String s) {
        return s == null ? "" : s.toLowerCase(Locale.ROOT);
    }
}
