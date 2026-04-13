package com.zhiqu.controller;

import com.zhiqu.common.Result;
import com.zhiqu.dto.TaskCreateRequest;
import com.zhiqu.entity.UserAiConfig;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.AiService;
import com.zhiqu.service.StudyTaskService;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/ai")
public class AiController {

    private static final DateTimeFormatter DT_FORMATTER =
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    private final AiService aiService;
    private final StudyTaskService studyTaskService;

    public AiController(AiService aiService, StudyTaskService studyTaskService) {
        this.aiService = aiService;
        this.studyTaskService = studyTaskService;
    }

    /**
     * 获取用户 AI 配置（API Key 脱敏返回）
     */
    @GetMapping("/config")
    public Result<UserAiConfig> getConfig() {
        Long userId = SecurityUtils.getCurrentUserId();
        UserAiConfig config = aiService.getConfig(userId);
        if (config != null && config.getApiKey() != null && config.getApiKey().length() > 8) {
            config.setApiKey(config.getApiKey().substring(0, 8) + "****");
        }
        return Result.success(config);
    }

    /**
     * 保存/更新 AI 配置
     */
    @PutMapping("/config")
    public Result<Void> saveConfig(@RequestBody Map<String, String> body) {
        Long userId = SecurityUtils.getCurrentUserId();
        aiService.saveConfig(
                userId,
                body.getOrDefault("apiUrl", "https://api.openai.com/v1/chat/completions"),
                body.get("apiKey"),
                body.getOrDefault("modelName", "gpt-3.5-turbo")
        );
        return Result.success();
    }

    /**
     * 上传文件并分析，返回结构化任务列表
     */
    @PostMapping("/analyze")
    public Result<List<Map<String, Object>>> analyzeFile(@RequestParam("file") MultipartFile file) {
        Long userId = SecurityUtils.getCurrentUserId();
        try {
            String content = new String(file.getBytes(), StandardCharsets.UTF_8);
            String fileName = file.getOriginalFilename() != null ? file.getOriginalFilename() : "未知文件";
            List<Map<String, Object>> tasks = aiService.analyzeContent(userId, content, fileName);
            return Result.success(tasks);
        } catch (Exception e) {
            throw new RuntimeException("文件读取失败：" + e.getMessage());
        }
    }

    /**
     * 普通对话
     */
    @PostMapping("/chat")
    public Result<String> chat(@RequestBody Map<String, String> body) {
        Long userId = SecurityUtils.getCurrentUserId();
        String message = body.get("message");
        String reply = aiService.chat(userId, message);
        return Result.success(reply);
    }

    /**
     * 批量创建任务（从 AI 分析结果确认后提交）
     */
    @PostMapping("/batch-create-tasks")
    public Result<Map<String, Object>> batchCreateTasks(@RequestBody List<Map<String, Object>> tasks) {
        Long userId = SecurityUtils.getCurrentUserId();
        int created = 0;
        int failed = 0;
        for (Map<String, Object> t : tasks) {
            try {
                TaskCreateRequest req = new TaskCreateRequest();
                req.setTitle(String.valueOf(t.getOrDefault("title", "")));
                req.setDescription((String) t.get("description"));

                Object quadrantVal = t.get("quadrant");
                req.setQuadrant(quadrantVal != null ? Integer.parseInt(quadrantVal.toString()) : 2);

                Object priorityVal = t.get("priority");
                req.setPriority(priorityVal != null ? Integer.parseInt(priorityVal.toString()) : 1);

                req.setStatus(0);

                Object deadlineVal = t.get("deadline");
                if (deadlineVal != null && !deadlineVal.toString().isBlank()) {
                    try {
                        req.setDeadline(LocalDateTime.parse(deadlineVal.toString(), DT_FORMATTER));
                    } catch (DateTimeParseException ignored) {
                        // 无法解析的截止时间忽略
                    }
                }

                studyTaskService.create(userId, req);
                created++;
            } catch (Exception e) {
                failed++;
            }
        }
        Map<String, Object> result = new HashMap<>();
        result.put("created", created);
        result.put("failed", failed);
        return Result.success(result);
    }
}
