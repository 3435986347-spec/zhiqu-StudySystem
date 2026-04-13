package com.zhiqu.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.UserAiConfig;
import com.zhiqu.mapper.UserAiConfigMapper;
import com.zhiqu.service.AiService;
import org.springframework.http.*;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import java.util.*;

@Service
public class AiServiceImpl implements AiService {

    private final UserAiConfigMapper configMapper;
    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;

    public AiServiceImpl(UserAiConfigMapper configMapper) {
        this.configMapper = configMapper;
        this.restTemplate = new RestTemplate();
        this.objectMapper = new ObjectMapper();
    }

    @Override
    public UserAiConfig getConfig(Long userId) {
        return configMapper.selectOne(
                new LambdaQueryWrapper<UserAiConfig>().eq(UserAiConfig::getUserId, userId)
        );
    }

    @Override
    public void saveConfig(Long userId, String apiUrl, String apiKey, String modelName) {
        UserAiConfig config = getConfig(userId);
        if (config == null) {
            config = new UserAiConfig();
            config.setUserId(userId);
            config.setApiUrl(apiUrl);
            config.setApiKey(apiKey);
            config.setModelName(modelName);
            configMapper.insert(config);
        } else {
            // 如果传入的 key 是脱敏格式（以 **** 结尾），保留原 key 不更新
            if (apiKey != null && !apiKey.endsWith("****")) {
                config.setApiKey(apiKey);
            }
            config.setApiUrl(apiUrl);
            config.setModelName(modelName);
            configMapper.updateById(config);
        }
    }

    @Override
    public List<Map<String, Object>> analyzeContent(Long userId, String content, String fileName) {
        UserAiConfig config = requireConfig(userId);
        String userMessage = "文件名：" + fileName + "\n\n文件内容：\n" + content;
        String aiResponse = callAiApi(config, getAnalyzeSystemPrompt(), userMessage);
        return parseTasksFromResponse(aiResponse);
    }

    @Override
    public List<Map<String, Object>> analyzeImage(Long userId, String base64Image, String mediaType, String fileName) {
        UserAiConfig config = requireConfig(userId);

        List<Map<String, Object>> userContent = new ArrayList<>();
        userContent.add(Map.of("type", "text",
                "text", "请分析这张图片中的课表/行程/学习安排，提取出所有任务。文件名：" + fileName));
        userContent.add(Map.of(
                "type", "image_url",
                "image_url", Map.of("url", "data:" + mediaType + ";base64," + base64Image)
        ));

        String aiResponse = callAiApiWithVision(config, getAnalyzeSystemPrompt(), userContent);
        return parseTasksFromResponse(aiResponse);
    }

    @Override
    public String chat(Long userId, String message) {
        UserAiConfig config = requireConfig(userId);
        String systemPrompt = "你是「知趣·象限学习系统」的 AI 助手，帮助大学生规划学习任务和时间管理。回答简洁友好。";
        return callAiApi(config, systemPrompt, message);
    }

    // ── 私有辅助方法 ──────────────────────────────────────

    /** 校验配置并返回，未配置时抛出业务异常 */
    private UserAiConfig requireConfig(Long userId) {
        UserAiConfig config = getConfig(userId);
        if (config == null || config.getApiKey() == null || config.getApiKey().isBlank()) {
            throw new BusinessException("请先在个人中心配置 AI 模型 API Key");
        }
        return config;
    }

    /** 统一的文件分析 System Prompt */
    private String getAnalyzeSystemPrompt() {
        return """
                你是一个学习规划助手。用户会发送课表、行程安排或学习计划的内容（可能是文字、图片或PDF）。
                请分析内容，提取出所有可以作为学习任务的项目。

                请严格按以下 JSON 数组格式返回，不要包含任何其他文字，不要用 markdown 代码块包裹：
                [
                  {
                    "title": "任务标题",
                    "description": "任务描述",
                    "deadline": "YYYY-MM-DD HH:mm:ss 格式的截止时间，如果无法确定则为 null",
                    "priority": 0到2的数字（0低1中2高）,
                    "suggestedQuadrant": 1到4的数字（你建议的象限分类）,
                    "reason": "你建议这个象限的理由（一句话）"
                  }
                ]

                象限说明：
                1 = 重要且紧急（考试、明天截止的作业）
                2 = 重要不紧急（长期学习计划、技能提升）
                3 = 紧急不重要（非核心的杂事、通知）
                4 = 不重要不紧急（可选活动、娱乐）

                如果图片或内容中包含具体的日期和时间信息，请尽量提取为 deadline。
                如果是周期性课表（如每周一上午的课），请按最近一周生成具体日期的任务。
                """;
    }

    /** 从 AI 响应中解析结构化任务列表 */
    private List<Map<String, Object>> parseTasksFromResponse(String aiResponse) {
        try {
            String jsonStr = extractJson(aiResponse);
            JsonNode array = objectMapper.readTree(jsonStr);
            List<Map<String, Object>> tasks = new ArrayList<>();
            for (JsonNode node : array) {
                Map<String, Object> task = new HashMap<>();
                task.put("title", node.has("title") ? node.get("title").asText() : "");
                task.put("description", node.has("description") ? node.get("description").asText() : "");
                task.put("deadline", node.has("deadline") && !node.get("deadline").isNull()
                        ? node.get("deadline").asText() : null);
                task.put("priority", node.has("priority") ? node.get("priority").asInt(0) : 0);
                task.put("suggestedQuadrant", node.has("suggestedQuadrant")
                        ? node.get("suggestedQuadrant").asInt(2) : 2);
                task.put("reason", node.has("reason") ? node.get("reason").asText() : "");
                tasks.add(task);
            }
            return tasks;
        } catch (Exception e) {
            throw new BusinessException("AI 返回格式解析失败，请重试");
        }
    }

    /** 调用 AI 文本接口（兼容 OpenAI / DeepSeek / 通义千问等） */
    private String callAiApi(UserAiConfig config, String systemPrompt, String userMessage) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            headers.setBearerAuth(config.getApiKey());

            Map<String, Object> body = new HashMap<>();
            body.put("model", config.getModelName());
            body.put("messages", List.of(
                    Map.of("role", "system", "content", systemPrompt),
                    Map.of("role", "user", "content", userMessage)
            ));
            body.put("temperature", 0.3);
            body.put("max_tokens", 4096);

            HttpEntity<Map<String, Object>> request = new HttpEntity<>(body, headers);
            ResponseEntity<String> response = restTemplate.postForEntity(config.getApiUrl(), request, String.class);

            JsonNode root = objectMapper.readTree(response.getBody());
            return root.at("/choices/0/message/content").asText();
        } catch (BusinessException e) {
            throw e;
        } catch (Exception e) {
            throw new BusinessException("AI 接口调用失败：" + e.getMessage());
        }
    }

    /** 调用 AI 视觉接口（携带 Base64 图片，OpenAI Vision 格式） */
    private String callAiApiWithVision(UserAiConfig config, String systemPrompt,
                                       List<Map<String, Object>> userContent) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            headers.setBearerAuth(config.getApiKey());

            Map<String, Object> body = new HashMap<>();
            body.put("model", config.getModelName());
            body.put("messages", List.of(
                    Map.of("role", "system", "content", systemPrompt),
                    Map.of("role", "user", "content", userContent)
            ));
            body.put("temperature", 0.3);
            body.put("max_tokens", 4096);

            HttpEntity<Map<String, Object>> request = new HttpEntity<>(body, headers);
            ResponseEntity<String> response = restTemplate.postForEntity(config.getApiUrl(), request, String.class);

            JsonNode root = objectMapper.readTree(response.getBody());
            return root.at("/choices/0/message/content").asText();
        } catch (BusinessException e) {
            throw e;
        } catch (Exception e) {
            String msg = e.getMessage() != null ? e.getMessage() : "";
            if (msg.contains("400") || msg.contains("unsupported") || msg.contains("vision")) {
                throw new BusinessException(
                        "当前模型不支持图片识别，请在个人中心切换为支持视觉的模型（如 gpt-4o、qwen-vl-plus）");
            }
            throw new BusinessException("AI 接口调用失败：" + msg);
        }
    }

    /** 从 AI 响应文本中提取 JSON 数组部分 */
    private String extractJson(String text) {
        int start = text.indexOf('[');
        int end = text.lastIndexOf(']');
        if (start >= 0 && end > start) {
            return text.substring(start, end + 1);
        }
        throw new RuntimeException("未找到 JSON 数组");
    }
}
