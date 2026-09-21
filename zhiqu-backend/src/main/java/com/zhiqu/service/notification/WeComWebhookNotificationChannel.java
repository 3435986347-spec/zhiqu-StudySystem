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

import java.util.Map;

@Component
public class WeComWebhookNotificationChannel implements NotificationChannel {
    private final RestTemplate restTemplate = new RestTemplate();
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Override
    public String channel() {
        return "WECOM";
    }

    @Override
    public void send(UserReminderSetting setting, String content) {
        if (setting == null || setting.getWebhookUrl() == null || setting.getWebhookUrl().isBlank()) {
            throw new BusinessException("企业微信 Webhook 未配置");
        }
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            Map<String, Object> body = Map.of(
                    "msgtype", "text",
                    "text", Map.of("content", content)
            );
            ResponseEntity<String> response = restTemplate.postForEntity(
                    setting.getWebhookUrl(),
                    new HttpEntity<>(body, headers),
                    String.class
            );
            JsonNode root = objectMapper.readTree(response.getBody());
            int errcode = root.path("errcode").asInt(0);
            if (errcode != 0) {
                throw new BusinessException("企业微信发送失败：" + root.path("errmsg").asText("unknown"));
            }
        } catch (BusinessException e) {
            throw e;
        } catch (Exception e) {
            throw new BusinessException("企业微信发送失败：" + e.getMessage());
        }
    }
}
