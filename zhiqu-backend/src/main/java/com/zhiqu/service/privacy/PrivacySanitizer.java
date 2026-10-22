package com.zhiqu.service.privacy;

import org.springframework.stereotype.Component;

import java.util.regex.Pattern;

@Component
public class PrivacySanitizer {
    private static final Pattern BEARER = Pattern.compile("(?i)Bearer\\s+[A-Za-z0-9._~+\\-/=]{12,}");
    private static final Pattern API_KEY_ASSIGNMENT = Pattern.compile("(?i)(api[_-]?key|appsecret|secret|token|authorization|cookie)(\\s*[:=]\\s*)([^\\s,;&\"']{6,})");
    private static final Pattern OPENAI_STYLE_KEY = Pattern.compile("\\b(sk-[A-Za-z0-9_\\-]{8,}|sk-ant-[A-Za-z0-9_\\-]{8,})\\b");
    private static final Pattern JWT = Pattern.compile("\\beyJ[A-Za-z0-9_\\-]+\\.[A-Za-z0-9_\\-]+\\.[A-Za-z0-9_\\-]+\\b");

    public String sanitize(String value) {
        if (value == null || value.isBlank()) {
            return value;
        }
        String result = value;
        result = BEARER.matcher(result).replaceAll("Bearer [REDACTED]");
        result = API_KEY_ASSIGNMENT.matcher(result).replaceAll("$1$2[REDACTED]");
        result = OPENAI_STYLE_KEY.matcher(result).replaceAll("[REDACTED_API_KEY]");
        result = JWT.matcher(result).replaceAll("[REDACTED_JWT]");
        return result;
    }
}
