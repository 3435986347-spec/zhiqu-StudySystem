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

import java.nio.charset.StandardCharsets;
import java.util.Map;

@Component
public class PushPlusNotificationChannel implements NotificationChannel {
    private static final String SEND_URL = "https://www.pushplus.plus/send/";

    private final RestTemplate restTemplate = new RestTemplate();
    private final ObjectMapper objectMapper = new ObjectMapper();

    @Override
    public String channel() {
        return "PUSHPLUS";
    }

    @Override
    public void send(UserReminderSetting setting, String content) {
        if (setting == null || setting.getPushplusToken() == null || setting.getPushplusToken().isBlank()) {
            throw new BusinessException("PushPlus Token 未配置");
        }
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(new MediaType("application", "json", StandardCharsets.UTF_8));
            Map<String, Object> body = Map.of(
                    "token", setting.getPushplusToken(),
                    "title", "知趣 DDL 早八提醒",
                    "content", content,
                    "template", "txt"
            );
            ResponseEntity<String> response = restTemplate.postForEntity(
                    SEND_URL,
                    new HttpEntity<>(body, headers),
                    String.class
            );
            JsonNode root = objectMapper.readTree(response.getBody());
            int code = root.path("code").asInt();
            if (code != 200) {
                throw new BusinessException("PushPlus 发送失败：" + root.path("msg").asText("unknown"));
            }
        } catch (BusinessException e) {
            throw e;
        } catch (Exception e) {
            throw new BusinessException("PushPlus 发送失败：" + e.getMessage());
        }
    }
}
