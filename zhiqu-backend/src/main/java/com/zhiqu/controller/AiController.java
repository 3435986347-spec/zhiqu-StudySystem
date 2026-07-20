package com.zhiqu.controller;

import com.zhiqu.common.BusinessException;
import com.zhiqu.common.Result;
import com.zhiqu.dto.TaskCreateRequest;
import com.zhiqu.entity.UserAiConfig;
import com.zhiqu.security.SecurityUtils;
import com.zhiqu.service.AdminGuard;
import com.zhiqu.service.AiService;
import com.zhiqu.service.AiWorkspaceService;
import com.zhiqu.service.RoutineService;
import com.zhiqu.service.StudyTaskService;
import com.zhiqu.service.ai.WebResearchService;
import com.zhiqu.service.concurrency.IdempotencyService;
import com.zhiqu.util.FileParseUtil;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/ai")
public class AiController {

    private static final DateTimeFormatter DT_FORMATTER =
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    private final AiService aiService;
    private final AiWorkspaceService aiWorkspaceService;
    private final StudyTaskService studyTaskService;
    private final RoutineService routineService;
    private final IdempotencyService idempotencyService;
    private final WebResearchService webResearchService;
    private final AdminGuard adminGuard;

    public AiController(AiService aiService,
                        AiWorkspaceService aiWorkspaceService,
                        StudyTaskService studyTaskService,
                        RoutineService routineService,
                        IdempotencyService idempotencyService,
                        WebResearchService webResearchService,
                        AdminGuard adminGuard) {
        this.aiService = aiService;
        this.aiWorkspaceService = aiWorkspaceService;
        this.studyTaskService = studyTaskService;
        this.routineService = routineService;
        this.idempotencyService = idempotencyService;
        this.webResearchService = webResearchService;
        this.adminGuard = adminGuard;
    }

    /**
     * 获取用户 AI 配置（API Key 脱敏返回）
     */
    @GetMapping("/config")
    public Result<UserAiConfig> getConfig() {
        Long userId = SecurityUtils.getCurrentUserId();
        UserAiConfig config = aiService.getConfig(userId);
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
     * 上传文件并分析（支持图片、PDF、文本三种类型）
     */
    @PostMapping("/analyze")
    public Result<List<Map<String, Object>>> analyzeFile(@RequestParam("file") MultipartFile file) {
        Long userId = SecurityUtils.getCurrentUserId();
        String contentType = file.getContentType();
        String fileName = file.getOriginalFilename() != null ? file.getOriginalFilename() : "未知文件";

        try {
            List<Map<String, Object>> tasks;

            if (FileParseUtil.isImage(contentType)) {
                // 图片：转 Base64 发给视觉模型
                String base64 = FileParseUtil.imageToBase64(file);
                String mediaType = FileParseUtil.getImageMediaType(contentType);
                tasks = aiService.analyzeImage(userId, base64, mediaType, fileName);

            } else if (FileParseUtil.isPdf(contentType)) {
                // PDF：提取文本后分析
                String text = FileParseUtil.extractPdfText(file);
                if (text == null || text.isBlank()) {
                    tasks = new ArrayList<>();
                    List<FileParseUtil.PdfPageImage> pageImages = FileParseUtil.extractPdfPageImages(file, 3);
                    if (pageImages.isEmpty()) {
                        throw new BusinessException("此 PDF 无法提取文字，也无法渲染为图片");
                    }
                    for (FileParseUtil.PdfPageImage pageImage : pageImages) {
                        tasks.addAll(aiService.analyzeImage(
                                userId,
                                pageImage.base64(),
                                pageImage.mediaType(),
                                fileName + " 第" + pageImage.pageNumber() + "页"
                        ));
                    }
                } else {
                    tasks = aiService.analyzeContent(userId, text, fileName);
                }

            } else if (FileParseUtil.isExcel(contentType, fileName)) {
                // Excel：转为行列文本后分析
                String text = FileParseUtil.extractExcelText(file);
                if (text == null || text.isBlank()) {
                    throw new BusinessException("未能从表格中读取到内容");
                }
                tasks = aiService.analyzeContent(userId, text, fileName);

            } else if (FileParseUtil.isText(contentType, fileName)) {
                // 文本文件：直接读取
                String content = new String(file.getBytes(), StandardCharsets.UTF_8);
                tasks = aiService.analyzeContent(userId, content, fileName);

            } else {
                throw new BusinessException("不支持的文件格式。支持：txt、md、csv、json、pdf、png、jpg、jpeg 等");
            }

            return Result.success(tasks);
        } catch (BusinessException e) {
            throw e;
        } catch (Exception e) {
            throw new BusinessException("文件处理失败：" + e.getMessage());
        }
    }

    /**
     * 普通对话
     */
    @PostMapping("/chat")
    public Result<Map<String, Object>> chat(@RequestBody Map<String, Object> body) {
        Long userId = SecurityUtils.getCurrentUserId();
        String message = String.valueOf(body.getOrDefault("message", ""));
        Long modelConfigId = parseLong(body.get("modelConfigId"));
        Boolean enableWebSearch = parseBoolean(body.get("enableWebSearch"));
        String reasoningMode = String.valueOf(body.getOrDefault("reasoningMode", "OFF"));
        Long notebookId = parseLong(body.get("notebookId"));
        return Result.success(aiService.chat(userId, message, modelConfigId, enableWebSearch, reasoningMode, notebookId));
    }

    @PostMapping(value = "/chat/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter streamChat(@RequestBody Map<String, Object> body) {
        Long userId = SecurityUtils.getCurrentUserId();
        String message = String.valueOf(body.getOrDefault("message", ""));
        Long modelConfigId = parseLong(body.get("modelConfigId"));
        Boolean enableWebSearch = parseBoolean(body.get("enableWebSearch"));
        String reasoningMode = String.valueOf(body.getOrDefault("reasoningMode", "OFF"));
        Long notebookId = parseLong(body.get("notebookId"));
        String agentMode = String.valueOf(body.getOrDefault("agentMode", "AUTO"));
        return aiService.streamChat(userId, message, modelConfigId, enableWebSearch, reasoningMode,
                notebookId, agentMode, castObjectMap(body.get("contextOptions")));
    }

    @GetMapping("/notebooks")
    public Result<List<Map<String, Object>>> listNotebooks() {
        return Result.success(aiWorkspaceService.listNotebooks(SecurityUtils.getCurrentUserId()));
    }

    @PostMapping("/notebooks")
    public Result<Map<String, Object>> createNotebook(@RequestBody Map<String, Object> body) {
        return Result.success(aiWorkspaceService.createNotebook(SecurityUtils.getCurrentUserId(), body));
    }

    @PutMapping("/notebooks/{id}")
    public Result<Map<String, Object>> updateNotebook(@PathVariable Long id,
                                                      @RequestBody Map<String, Object> body) {
        return Result.success(aiWorkspaceService.updateNotebook(SecurityUtils.getCurrentUserId(), id, body));
    }

    @DeleteMapping("/notebooks/{id}")
    public Result<Void> deleteNotebook(@PathVariable Long id) {
        aiWorkspaceService.deleteNotebook(SecurityUtils.getCurrentUserId(), id);
        return Result.success();
    }

    @GetMapping("/notebooks/{id}/sources")
    public Result<List<Map<String, Object>>> listNotebookSources(@PathVariable Long id) {
        return Result.success(aiWorkspaceService.listSources(SecurityUtils.getCurrentUserId(), id));
    }

    @PostMapping("/notebooks/{id}/sources")
    public Result<Map<String, Object>> createNotebookSource(@PathVariable Long id,
                                                            @RequestBody Map<String, Object> body) {
        return Result.success(aiWorkspaceService.createSource(SecurityUtils.getCurrentUserId(), id, body));
    }

    @PostMapping("/notebooks/{id}/sources/upload")
    public Result<Map<String, Object>> uploadNotebookSource(@PathVariable Long id,
                                                            @RequestParam("file") MultipartFile file) {
        return Result.success(aiWorkspaceService.uploadSource(SecurityUtils.getCurrentUserId(), id, file));
    }

    @DeleteMapping("/notebooks/{id}/sources/{sourceId}")
    public Result<Void> deleteNotebookSource(@PathVariable Long id, @PathVariable Long sourceId) {
        aiWorkspaceService.deleteSource(SecurityUtils.getCurrentUserId(), id, sourceId);
        return Result.success();
    }

    @GetMapping("/notebooks/{id}/sources/{sourceId}/download")
    public ResponseEntity<byte[]> downloadNotebookSource(@PathVariable Long id, @PathVariable Long sourceId) {
        Map<String, Object> data = aiWorkspaceService.downloadSource(SecurityUtils.getCurrentUserId(), id, sourceId);
        String filename = String.valueOf(data.get("filename"));
        String encoded = URLEncoder.encode(filename, StandardCharsets.UTF_8).replace("+", "%20");
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename*=UTF-8''" + encoded)
                .header(HttpHeaders.CONTENT_TYPE, String.valueOf(data.get("contentType")))
                .body((byte[]) data.get("bytes"));
    }

    @GetMapping("/agent-runs/{id}")
    public Result<Map<String, Object>> getAgentRun(@PathVariable Long id) {
        return Result.success(aiWorkspaceService.getRun(SecurityUtils.getCurrentUserId(), id));
    }

    @GetMapping("/agent-runs")
    public Result<List<Map<String, Object>>> listAgentRuns(@RequestParam(required = false) Long notebookId) {
        return Result.success(aiWorkspaceService.listRuns(SecurityUtils.getCurrentUserId(), notebookId));
    }

    /** body 可选：{tasks:[...], routines:[...]} —— 用户在确认弹窗里“修改”后提交的条目，覆盖草稿原内容后再落库。 */
    @PostMapping("/artifacts/{id}/confirm")
    public Result<Map<String, Object>> confirmArtifact(@PathVariable Long id,
                                                       @RequestBody(required = false) Map<String, Object> body) {
        return Result.success(aiWorkspaceService.confirmArtifact(SecurityUtils.getCurrentUserId(), id, body));
    }

    @PostMapping("/artifacts/{id}/discard")
    public Result<Map<String, Object>> discardArtifact(@PathVariable Long id) {
        return Result.success(aiWorkspaceService.discardArtifact(SecurityUtils.getCurrentUserId(), id));
    }

    @GetMapping("/models")
    public Result<Map<String, Object>> listModels() {
        return Result.success(aiService.listModels(SecurityUtils.getCurrentUserId()));
    }

    @PostMapping("/models")
    public Result<Map<String, Object>> createModel(@RequestBody Map<String, Object> body) {
        return Result.success(aiService.saveModel(SecurityUtils.getCurrentUserId(), null, body));
    }

    @PutMapping("/models/{id}")
    public Result<Map<String, Object>> updateModel(@PathVariable Long id,
                                                   @RequestBody Map<String, Object> body) {
        return Result.success(aiService.saveModel(SecurityUtils.getCurrentUserId(), id, body));
    }

    @DeleteMapping("/models/{id}")
    public Result<Void> deleteModel(@PathVariable Long id) {
        aiService.deleteModel(SecurityUtils.getCurrentUserId(), id);
        return Result.success();
    }

    @PostMapping("/models/{id}/test")
    public Result<Map<String, Object>> testModel(@PathVariable Long id) {
        return Result.success(aiService.testModel(SecurityUtils.getCurrentUserId(), id));
    }

    @PostMapping("/models/{id}/probe")
    public Result<Map<String, Object>> probeModel(@PathVariable Long id) {
        return Result.success(aiService.probeModel(SecurityUtils.getCurrentUserId(), id));
    }

    @PostMapping("/web-fetch/test")
    public Result<Map<String, Object>> testWebFetch(@RequestBody Map<String, Object> body) {
        Long userId = SecurityUtils.getCurrentUserId();
        adminGuard.requireAdmin(userId);
        var fetched = webResearchService.fetch(String.valueOf(body.getOrDefault("url", "")));
        Map<String, Object> data = new HashMap<>();
        data.put("title", fetched.title());
        data.put("url", fetched.url());
        data.put("snippet", fetched.snippet());
        data.put("sourceType", fetched.sourceType());
        data.put("status", fetched.status());
        return Result.success(data);
    }

    @GetMapping("/memory")
    public Result<Map<String, Object>> getMemory() {
        Long userId = SecurityUtils.getCurrentUserId();
        return Result.success(aiService.getMemory(userId));
    }

    @GetMapping("/messages")
    public Result<List<Map<String, Object>>> getMessages(
            @RequestParam(defaultValue = "50") Integer limit,
            @RequestParam(required = false) Long notebookId) {
        Long userId = SecurityUtils.getCurrentUserId();
        return Result.success(aiService.getRecentChatMessages(userId, notebookId, limit));
    }

    @DeleteMapping("/messages/{id}")
    public Result<Void> deleteMessage(@PathVariable Long id) {
        Long userId = SecurityUtils.getCurrentUserId();
        aiService.deleteChatMessage(userId, id);
        return Result.success();
    }

    @PutMapping("/memory")
    public Result<Void> saveMemory(@RequestBody Map<String, String> body) {
        Long userId = SecurityUtils.getCurrentUserId();
        aiService.saveMemory(userId, body.getOrDefault("memoryText", ""));
        return Result.success();
    }

    @DeleteMapping("/memory")
    public Result<Void> clearMemory() {
        Long userId = SecurityUtils.getCurrentUserId();
        aiService.clearMemory(userId);
        return Result.success();
    }

    /**
     * 批量创建任务（从 AI 分析结果确认后提交）
     */
    @PostMapping("/batch-create-tasks")
    public Result<Map<String, Object>> batchCreateTasks(@RequestBody List<Map<String, Object>> tasks,
                                                        @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey) {
        Long userId = SecurityUtils.getCurrentUserId();
        return idempotencyService.execute(userId, idempotencyKey,
                () -> Result.success(createTasksFromMaps(userId, tasks)));
    }

    @PostMapping("/batch-create-plan")
    public Result<Map<String, Object>> batchCreatePlan(@RequestBody Map<String, Object> body,
                                                       @RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey) {
        Long userId = SecurityUtils.getCurrentUserId();
        return idempotencyService.execute(userId, idempotencyKey, () -> {
            Map<String, Object> taskResult = createTasksFromMaps(userId, castMapList(body.get("tasks")));
            int createdRoutines = routineService.createBatch(userId, castMapList(body.get("routines"))).size();
            Map<String, Object> result = new HashMap<>();
            result.put("createdTasks", taskResult.getOrDefault("created", 0));
            result.put("failedTasks", taskResult.getOrDefault("failed", 0));
            result.put("createdRoutines", createdRoutines);
            return Result.success(result);
        });
    }

    private Map<String, Object> createTasksFromMaps(Long userId, List<Map<String, Object>> tasks) {
        int created = 0;
        int failed = 0;
        if (tasks == null) {
            tasks = List.of();
        }
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
                req.setTaskType(stringValue(t.get("taskType")));
                req.setDifficulty(parseInteger(t.get("difficulty")));
                req.setAiReminderReason(firstNonBlank(t.get("aiReminderReason"), t.get("reminderReason")));
                req.setReminderOffsets(parseIntegerList(
                        t.containsKey("reminderOffsets") ? t.get("reminderOffsets") : t.get("suggestedReminderOffsets")));

                Object startTimeVal = t.get("startTime");
                if (startTimeVal != null && !startTimeVal.toString().isBlank()) {
                    try {
                        req.setStartTime(LocalDateTime.parse(startTimeVal.toString(), DT_FORMATTER));
                    } catch (DateTimeParseException ignored) {
                        // 无法解析的开始时间忽略
                    }
                }

                Object durationVal = t.get("durationMinutes");
                if (durationVal != null && !durationVal.toString().isBlank()) {
                    try {
                        req.setDurationMinutes(Integer.parseInt(durationVal.toString()));
                    } catch (NumberFormatException ignored) {
                        // 无法解析的时长忽略
                    }
                }

                Object repeatVal = t.get("repeatWeeks");
                if (repeatVal != null && !repeatVal.toString().isBlank()) {
                    try {
                        req.setRepeatWeeks(Integer.parseInt(repeatVal.toString()));
                    } catch (NumberFormatException ignored) {
                        // 无法解析的周数忽略
                    }
                }

                Object deadlineVal = t.get("deadline");
                if (deadlineVal != null && !deadlineVal.toString().isBlank()) {
                    try {
                        req.setDeadline(LocalDateTime.parse(deadlineVal.toString(), DT_FORMATTER));
                    } catch (DateTimeParseException ignored) {
                        // 无法解析的截止时间忽略
                    }
                }

                if (req.getRepeatWeeks() != null && req.getRepeatWeeks() > 1 && req.getStartTime() != null) {
                    created += studyTaskService.createRepeated(userId, req).size();
                } else {
                    studyTaskService.create(userId, req);
                    created++;
                }
            } catch (Exception e) {
                failed++;
            }
        }
        Map<String, Object> result = new HashMap<>();
        result.put("created", created);
        result.put("failed", failed);
        return result;
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> castMapList(Object value) {
        if (!(value instanceof List<?> raw)) {
            return List.of();
        }
        List<Map<String, Object>> result = new ArrayList<>();
        for (Object item : raw) {
            if (item instanceof Map<?, ?> map) {
                result.add((Map<String, Object>) map);
            }
        }
        return result;
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> castObjectMap(Object value) {
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> result = new HashMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (entry.getKey() != null) {
                    result.put(String.valueOf(entry.getKey()), entry.getValue());
                }
            }
            return result;
        }
        return new HashMap<>();
    }

    private String stringValue(Object value) {
        if (value == null) {
            return null;
        }
        String text = value.toString().trim();
        return text.isBlank() ? null : text;
    }

    private String firstNonBlank(Object first, Object second) {
        String firstText = stringValue(first);
        return firstText != null ? firstText : stringValue(second);
    }

    private Integer parseInteger(Object value) {
        if (value == null || value.toString().isBlank()) {
            return null;
        }
        try {
            return Integer.parseInt(value.toString());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private Long parseLong(Object value) {
        if (value == null || value.toString().isBlank()) {
            return null;
        }
        try {
            return Long.parseLong(value.toString());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private Boolean parseBoolean(Object value) {
        if (value instanceof Boolean bool) {
            return bool;
        }
        if (value == null) {
            return false;
        }
        return Boolean.parseBoolean(value.toString());
    }

    private List<Integer> parseIntegerList(Object value) {
        List<Integer> result = new ArrayList<>();
        if (value == null) {
            return result;
        }
        if (value instanceof List<?> list) {
            for (Object item : list) {
                Integer parsed = parseInteger(item);
                if (parsed != null && parsed >= 0 && parsed <= 365 && !result.contains(parsed)) {
                    result.add(parsed);
                }
            }
        } else {
            String[] parts = value.toString().split(",");
            for (String part : parts) {
                Integer parsed = parseInteger(part.trim());
                if (parsed != null && parsed >= 0 && parsed <= 365 && !result.contains(parsed)) {
                    result.add(parsed);
                }
            }
        }
        return result;
    }
}
