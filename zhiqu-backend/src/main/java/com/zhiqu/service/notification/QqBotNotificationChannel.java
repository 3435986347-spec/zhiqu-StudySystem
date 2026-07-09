package com.zhiqu.service.notification;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.UserReminderSetting;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

import java.time.Instant;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Component
public class QqBotNotificationChannel implements NotificationChannel {
    private static final String TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
    private static final String PROD_API_BASE = "https://api.sgroup.qq.com";
    private static final String SANDBOX_API_BASE = "https://sandbox.api.sgroup.qq.com";

    private final RestTemplate restTemplate = new RestTemplate();
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final Map<String, TokenCache> tokenCacheMap = new ConcurrentHashMap<>();

    @Override
    public String channel() {
        return "QQ";
    }

    @Override
    public void send(UserReminderSetting setting, String content) {
        validate(setting);
        try {
            String token = getAccessToken(setting);
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            headers.set("Authorization", "QQBot " + token);

            String baseUrl = setting.getQqSandbox() != null && setting.getQqSandbox() == 1
                    ? SANDBOX_API_BASE
                    : PROD_API_BASE;
            String url = baseUrl + "/v2/groups/" + setting.getQqGroupOpenid() + "/messages";
            Map<String, Object> body = Map.of(
                    "content", content,
                    "msg_type", 0
            );
            restTemplate.postForEntity(url, new HttpEntity<>(body, headers), String.class);
        } catch (BusinessException e) {
            throw e;
        } catch (Exception e) {
            throw new BusinessException("QQ 机器人发送失败：" + e.getMessage());
        }
    }

    private String getAccessToken(UserReminderSetting setting) {
        String cacheKey = setting.getQqAppId() + ":" + setting.getQqAppSecret();
        TokenCache cache = tokenCacheMap.get(cacheKey);
        if (cache != null && cache.expiresAt().isAfter(Instant.now().plusSeconds(60))) {
            return cache.accessToken();
        }
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            Map<String, Object> body = Map.of(
                    "appId", setting.getQqAppId(),
                    "clientSecret", setting.getQqAppSecret()
            );
            ResponseEntity<String> response = restTemplate.postForEntity(
                    TOKEN_URL,
                    new HttpEntity<>(body, headers),
                    String.class
            );
            JsonNode root = objectMapper.readTree(response.getBody());
            String accessToken = root.path("access_token").asText();
            int expiresIn = root.path("expires_in").asInt(7200);
            if (accessToken == null || accessToken.isBlank()) {
                throw new BusinessException("QQ 机器人获取 AccessToken 失败");
            }
            tokenCacheMap.put(cacheKey, new TokenCache(accessToken, Instant.now().plusSeconds(Math.max(60, expiresIn))));
            return accessToken;
        } catch (BusinessException e) {
            throw e;
        } catch (Exception e) {
            throw new BusinessException("QQ 机器人获取 AccessToken 失败：" + e.getMessage());
        }
    }

    private void validate(UserReminderSetting setting) {
        if (setting == null) {
            throw new BusinessException("QQ 机器人配置不存在");
        }
        if (isBlank(setting.getQqAppId())) {
            throw new BusinessException("QQ 机器人 AppID 未配置");
        }
        if (isBlank(setting.getQqAppSecret())) {
            throw new BusinessException("QQ 机器人 AppSecret 未配置");
        }
        if (isBlank(setting.getQqGroupOpenid())) {
            throw new BusinessException("QQ 群 group_openid 未配置");
        }
    }

    private boolean isBlank(String text) {
        return text == null || text.isBlank();
    }

    private record TokenCache(String accessToken, Instant expiresAt) {
    }
}
