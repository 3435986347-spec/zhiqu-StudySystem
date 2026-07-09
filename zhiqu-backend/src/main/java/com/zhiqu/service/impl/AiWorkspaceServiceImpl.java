package com.zhiqu.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.dto.TaskCreateRequest;
import com.zhiqu.entity.*;
import com.zhiqu.mapper.*;
import com.zhiqu.service.AgentBlackboardService;
import com.zhiqu.service.AgentTaskGraphService;
import com.zhiqu.service.AiWorkspaceService;
import com.zhiqu.service.RoutineService;
import com.zhiqu.service.StudyTaskService;
import com.zhiqu.service.ai.WebResearchService;
import com.zhiqu.service.ai.WebSearchProvider;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import com.zhiqu.util.FileParseUtil;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.*;

@Service
public class AiWorkspaceServiceImpl implements AiWorkspaceService {
    private static final int CHUNK_SIZE = 2200;
    private static final int CHUNK_OVERLAP = 180;
    private static final int MAX_CONTEXT_CHUNKS = 8;
    private static final DateTimeFormatter DATE_TIME_FORMATTER = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    /** 原件私有存储目录：不在 /uploads/** 公开映射内，只能经鉴权下载端点访问 */
    @Value("${app.private-upload-dir:private-uploads}")
    private String privateUploadDir;

    private final AiNotebookMapper notebookMapper;
    private final AiNotebookSourceMapper sourceMapper;
    private final AiSourceChunkMapper chunkMapper;
    private final AiAgentRunMapper runMapper;
    private final AiAgentStepMapper stepMapper;
    private final AiAgentArtifactMapper artifactMapper;
    private final AiMessageMapper messageMapper;
    private final KnowledgeSourceMapper knowledgeSourceMapper;
    private final KnowledgePatchSetMapper knowledgePatchSetMapper;
    private final UserKnowledgeRevisionMapper knowledgeRevisionMapper;
    private final UserKnowledgePageMapper knowledgePageMapper;
    private final WebResearchService webResearchService;
    private final SensitiveCryptoService cryptoService;
    private final StudyTaskService studyTaskService;
    private final RoutineService routineService;
    private final AgentTaskGraphService taskGraphService;
    private final AgentBlackboardService blackboardService;
    private final ObjectMapper objectMapper;

    public AiWorkspaceServiceImpl(AiNotebookMapper notebookMapper,
                                  AiNotebookSourceMapper sourceMapper,
                                  AiSourceChunkMapper chunkMapper,
                                  AiAgentRunMapper runMapper,
                                  AiAgentStepMapper stepMapper,
                                  AiAgentArtifactMapper artifactMapper,
                                  AiMessageMapper messageMapper,
                                  KnowledgeSourceMapper knowledgeSourceMapper,
                                  KnowledgePatchSetMapper knowledgePatchSetMapper,
                                  UserKnowledgeRevisionMapper knowledgeRevisionMapper,
                                  UserKnowledgePageMapper knowledgePageMapper,
                                  WebResearchService webResearchService,
                                  SensitiveCryptoService cryptoService,
                                  StudyTaskService studyTaskService,
                                  RoutineService routineService,
                                  AgentTaskGraphService taskGraphService,
                                  AgentBlackboardService blackboardService,
                                  ObjectMapper objectMapper) {
        this.notebookMapper = notebookMapper;
        this.sourceMapper = sourceMapper;
        this.chunkMapper = chunkMapper;
        this.runMapper = runMapper;
        this.stepMapper = stepMapper;
        this.artifactMapper = artifactMapper;
        this.messageMapper = messageMapper;
        this.knowledgeSourceMapper = knowledgeSourceMapper;
        this.knowledgePatchSetMapper = knowledgePatchSetMapper;
        this.knowledgeRevisionMapper = knowledgeRevisionMapper;
        this.knowledgePageMapper = knowledgePageMapper;
        this.webResearchService = webResearchService;
        this.cryptoService = cryptoService;
        this.studyTaskService = studyTaskService;
        this.routineService = routineService;
        this.taskGraphService = taskGraphService;
        this.blackboardService = blackboardService;
        this.objectMapper = objectMapper;
    }

    @Override
    public List<Map<String, Object>> listNotebooks(Long userId) {
        ensureDefaultNotebook(userId);
        return notebookMapper.selectList(new LambdaQueryWrapper<AiNotebook>()
                        .eq(AiNotebook::getUserId, userId)
                        .orderByDesc(AiNotebook::getUpdatedAt)
                        .orderByDesc(AiNotebook::getId))
                .stream().map(this::notebookRow).toList();
    }

    @Override
    @Transactional
    public Map<String, Object> createNotebook(Long userId, Map<String, Object> body) {
        AiNotebook notebook = new AiNotebook();
        notebook.setUserId(userId);
        notebook.setTitle(limit(text(body.get("title"), "默认 Notebook"), 120));
        notebook.setDescription(limit(text(body.get("description"), ""), 500));
        notebook.setStatus("ACTIVE");
        notebookMapper.insert(notebook);
        return notebookRow(notebookMapper.selectById(notebook.getId()));
    }

    @Override
    @Transactional
    public Map<String, Object> updateNotebook(Long userId, Long id, Map<String, Object> body) {
        AiNotebook notebook = ownedNotebook(userId, id);
        if (body.containsKey("title")) {
            notebook.setTitle(limit(text(body.get("title"), notebook.getTitle()), 120));
        }
        if (body.containsKey("description")) {
            notebook.setDescription(limit(text(body.get("description"), ""), 500));
        }
        notebookMapper.updateById(notebook);
        return notebookRow(notebookMapper.selectById(id));
    }

    @Override
    @Transactional
    public void deleteNotebook(Long userId, Long id) {
        AiNotebook notebook = ownedNotebook(userId, id);
        notebookMapper.deleteById(notebook.getId());
    }

    @Override
    @Transactional
    public void deleteSource(Long userId, Long notebookId, Long sourceId) {
        ownedNotebook(userId, notebookId);
        AiNotebookSource source = sourceMapper.selectOne(new LambdaQueryWrapper<AiNotebookSource>()
                .eq(AiNotebookSource::getUserId, userId)
                .eq(AiNotebookSource::getNotebookId, notebookId)
                .eq(AiNotebookSource::getId, sourceId));
        if (source == null) {
            throw new BusinessException("资料不存在或无权限访问");
        }
        chunkMapper.delete(new LambdaQueryWrapper<AiSourceChunk>()
                .eq(AiSourceChunk::getSourceId, source.getId()));
        sourceMapper.deleteById(source.getId());
    }

    @Override
    @Transactional
    public AiNotebook ensureDefaultNotebook(Long userId) {
        AiNotebook existing = notebookMapper.selectOne(new LambdaQueryWrapper<AiNotebook>()
                .eq(AiNotebook::getUserId, userId)
                .orderByAsc(AiNotebook::getId)
                .last("LIMIT 1"));
        if (existing != null) {
            return existing;
        }
        AiNotebook notebook = new AiNotebook();
        notebook.setUserId(userId);
        notebook.setTitle("默认 Notebook");
        notebook.setDescription("AI 助手的默认资料工作区");
        notebook.setStatus("ACTIVE");
        notebookMapper.insert(notebook);
        return notebook;
    }

    @Override
    public List<Map<String, Object>> listSources(Long userId, Long notebookId) {
        Long resolvedNotebookId = resolveNotebookId(userId, notebookId);
        return sourceMapper.selectList(new LambdaQueryWrapper<AiNotebookSource>()
                        .eq(AiNotebookSource::getUserId, userId)
                        .eq(AiNotebookSource::getNotebookId, resolvedNotebookId)
                        .orderByDesc(AiNotebookSource::getUpdatedAt)
                        .orderByDesc(AiNotebookSource::getId))
                .stream().map(this::sourceRow).toList();
    }

    @Override
    @Transactional
    public Map<String, Object> createSource(Long userId, Long notebookId, Map<String, Object> body) {
        Long resolvedNotebookId = resolveNotebookId(userId, notebookId);
        String url = text(body.get("url"), "");
        String content = text(body.get("content"), "");
        String title = limit(text(body.get("title"), url.isBlank() ? "手动笔记" : url), 180);
        String sourceType = text(body.get("sourceType"), url.isBlank() ? "MANUAL_NOTE" : "WEB_URL").toUpperCase(Locale.ROOT);
        AiNotebookSource source = createSourceShell(userId, resolvedNotebookId, sourceType, title, url, null);
        try {
            source.setStatus("PARSING");
            sourceMapper.updateById(source);
            String parsed = content;
            if (!url.isBlank()) {
                WebSearchProvider.SearchResult fetched = webResearchService.fetch(url);
                source.setTitle(limit(text(fetched.title(), title), 180));
                if (!"OK".equalsIgnoreCase(fetched.status())) {
                    throw new BusinessException(fetched.snippet());
                }
                parsed = fetched.snippet();
            }
            writeChunks(source, parsed, Map.of("sourceType", sourceType));
            source.setStatus("READY");
            source.setParseError(null);
            sourceMapper.updateById(source);
        } catch (Exception e) {
            source.setStatus("ERROR");
            source.setParseError(limit(errorMessage(e), 1000));
            sourceMapper.updateById(source);
        }
        return sourceRow(sourceMapper.selectById(source.getId()));
    }

    @Override
    @Transactional
    public Map<String, Object> uploadSource(Long userId, Long notebookId, MultipartFile file) {
        if (file == null || file.isEmpty()) {
            throw new BusinessException("文件不能为空");
        }
        Long resolvedNotebookId = resolveNotebookId(userId, notebookId);
        String fileName = file.getOriginalFilename() == null ? "未命名文件" : file.getOriginalFilename();
        AiNotebookSource source = createSourceShell(userId, resolvedNotebookId, inferSourceType(file.getContentType(), fileName),
                limit(fileName, 180), null, null);
        // 原件落盘（私有目录），供后续下载；落盘失败不影响解析，下载会回退为导出解析文本
        try {
            Path dir = privateUploadRoot().resolve("ai-sources").resolve(String.valueOf(userId));
            Files.createDirectories(dir);
            Path target = dir.resolve(source.getId() + "-" + sanitizeStoredName(fileName));
            Files.copy(file.getInputStream(), target, StandardCopyOption.REPLACE_EXISTING);
            source.setFilePath(target.toString());
            sourceMapper.updateById(source);
        } catch (Exception ignored) {
        }
        try {
            source.setStatus("PARSING");
            sourceMapper.updateById(source);
            String parsed = extractFileText(file);
            writeChunks(source, parsed, Map.of("fileName", fileName));
            source.setStatus("READY");
            source.setParseError(null);
            sourceMapper.updateById(source);
        } catch (Exception e) {
            source.setStatus("ERROR");
            source.setParseError(limit(errorMessage(e), 1000));
            sourceMapper.updateById(source);
        }
        return sourceRow(sourceMapper.selectById(source.getId()));
    }

    @Override
    public Map<String, Object> downloadSource(Long userId, Long notebookId, Long sourceId) {
        ownedNotebook(userId, notebookId);
        AiNotebookSource source = sourceMapper.selectOne(new LambdaQueryWrapper<AiNotebookSource>()
                .eq(AiNotebookSource::getUserId, userId)
                .eq(AiNotebookSource::getNotebookId, notebookId)
                .eq(AiNotebookSource::getId, sourceId));
        if (source == null) {
            throw new BusinessException("资料不存在或无权限访问");
        }
        Map<String, Object> result = new LinkedHashMap<>();
        // 优先给原件；没有原件（URL/手动笔记/历史数据）则导出解析文本
        if (source.getFilePath() != null && !source.getFilePath().isBlank()) {
            Path path = Paths.get(source.getFilePath());
            if (Files.isRegularFile(path)) {
                try {
                    result.put("bytes", Files.readAllBytes(path));
                    String probed = Files.probeContentType(path);
                    result.put("contentType", probed == null ? "application/octet-stream" : probed);
                    result.put("filename", source.getTitle() == null ? path.getFileName().toString() : source.getTitle());
                    return result;
                } catch (Exception e) {
                    throw new BusinessException("原件读取失败：" + e.getMessage());
                }
            }
        }
        List<AiSourceChunk> chunks = chunkMapper.selectList(new LambdaQueryWrapper<AiSourceChunk>()
                .eq(AiSourceChunk::getSourceId, source.getId())
                .orderByAsc(AiSourceChunk::getChunkIndex));
        if (chunks.isEmpty()) {
            throw new BusinessException("该资料没有可下载的内容");
        }
        StringBuilder text = new StringBuilder();
        if (source.getUrl() != null && !source.getUrl().isBlank()) {
            text.append("来源网址：").append(source.getUrl()).append("\n\n");
        }
        for (AiSourceChunk chunk : chunks) {
            text.append(chunk.getContent() == null ? "" : chunk.getContent());
        }
        String base = source.getTitle() == null || source.getTitle().isBlank() ? "资料" : source.getTitle();
        result.put("bytes", text.toString().getBytes(StandardCharsets.UTF_8));
        result.put("contentType", "text/plain;charset=UTF-8");
        result.put("filename", base.toLowerCase().endsWith(".txt") ? base : base + ".txt");
        return result;
    }

    private Path privateUploadRoot() {
        Path configured = Paths.get(privateUploadDir);
        if (configured.isAbsolute()) {
            return configured.normalize();
        }
        return Paths.get(System.getProperty("user.dir")).toAbsolutePath().resolve(configured).normalize();
    }

    private String sanitizeStoredName(String name) {
        String cleaned = String.valueOf(name).replaceAll("[\\\\/:*?\"<>|\\r\\n]", "_").trim();
        if (cleaned.isBlank()) {
            cleaned = "file";
        }
        return cleaned.length() > 120 ? cleaned.substring(cleaned.length() - 120) : cleaned;
    }

    @Override
    public List<Map<String, Object>> sourceContext(Long userId, Long notebookId, Map<String, Object> contextOptions) {
        List<Long> selectedIds = longList(contextOptions == null ? null : contextOptions.get("selectedSourceIds"));
        if (notebookId == null) {
            if (!selectedIds.isEmpty()) {
                throw new BusinessException("Notebook is required when selecting sources.");
            }
            if (contextOptions != null && (Boolean.TRUE.equals(contextOptions.get("includeWiki"))
                    || !longList(contextOptions.get("selectedWikiPageIds")).isEmpty())) {
                return wikiContext(userId, contextOptions);
            }
            return List.of();
        }
        ownedNotebook(userId, notebookId);
        LambdaQueryWrapper<AiNotebookSource> sourceQuery = new LambdaQueryWrapper<AiNotebookSource>()
                .eq(AiNotebookSource::getUserId, userId)
                .eq(AiNotebookSource::getNotebookId, notebookId)
                .eq(AiNotebookSource::getStatus, "READY");
        if (!selectedIds.isEmpty()) {
            sourceQuery.in(AiNotebookSource::getId, selectedIds);
        }
        List<AiNotebookSource> sources = sourceMapper.selectList(sourceQuery.orderByDesc(AiNotebookSource::getUpdatedAt));
        if (!selectedIds.isEmpty() && sources.size() != selectedIds.size()) {
            throw new BusinessException("选择的资料不存在、不可用或无权限访问");
        }
        List<Map<String, Object>> rows = new ArrayList<>();
        for (AiNotebookSource source : sources) {
            List<AiSourceChunk> chunks = chunkMapper.selectList(new LambdaQueryWrapper<AiSourceChunk>()
                    .eq(AiSourceChunk::getSourceId, source.getId())
                    .orderByAsc(AiSourceChunk::getChunkIndex)
                    .last("LIMIT " + Math.max(2, MAX_CONTEXT_CHUNKS)));
            for (AiSourceChunk chunk : chunks) {
                rows.add(Map.of(
                        "sourceId", source.getId(),
                        "title", source.getTitle(),
                        "sourceType", source.getSourceType(),
                        "chunkIndex", chunk.getChunkIndex(),
                        "content", chunk.getContent()
                ));
                if (rows.size() >= MAX_CONTEXT_CHUNKS * 3) {
                    break;
                }
            }
        }
        if (contextOptions != null && Boolean.TRUE.equals(contextOptions.get("includeWiki"))) {
            rows.addAll(wikiContext(userId, contextOptions));
        }
        rows = sortContextRows(rows, text(contextOptions == null ? null : contextOptions.get("query"), ""));
        return rows.size() > MAX_CONTEXT_CHUNKS ? rows.subList(0, MAX_CONTEXT_CHUNKS) : rows;
    }

    @Override
    @Transactional
    public AiAgentRun beginRun(Long userId, Long notebookId, String agentMode, Map<String, Object> contextOptions,
                               AiMessage userMessage, AiMessage assistantMessage) {
        Long resolvedNotebookId = notebookId == null ? null : ownedNotebook(userId, notebookId).getId();
        AiAgentRun run = new AiAgentRun();
        run.setUserId(userId);
        run.setNotebookId(resolvedNotebookId);
        run.setUserMessageId(userMessage == null ? null : userMessage.getId());
        run.setAssistantMessageId(assistantMessage == null ? null : assistantMessage.getId());
        run.setStatus("RUNNING");
        run.setAgentMode(normalizeAgentMode(agentMode));
        run.setContextOptionsJson(toJson(contextOptions == null ? Map.of() : contextOptions));
        run.setExecutionMode("SERIAL");
        run.setMaxSteps(20);
        run.setMaxParallelTasks(3);
        run.setTimeoutSeconds(120);
        runMapper.insert(run);
        if (userMessage != null) {
            userMessage.setAgentRunId(run.getId());
            messageMapper.updateById(userMessage);
        }
        if (assistantMessage != null) {
            assistantMessage.setAgentRunId(run.getId());
            messageMapper.updateById(assistantMessage);
        }
        return run;
    }

    @Override
    @Transactional
    public AiAgentStep startStep(Long runId, String agentType, int order, String publicSummary) {
        return startStep(runId, null, agentType, order, publicSummary);
    }

    @Override
    @Transactional
    public AiAgentStep startStep(Long runId, Long taskId, String agentType, int order, String publicSummary) {
        AiAgentStep step = new AiAgentStep();
        step.setRunId(runId);
        step.setTaskId(taskId);
        step.setAgentType(agentType);
        step.setStepOrder(order);
        step.setAttemptNo(1);
        step.setStatus("RUNNING");
        step.setPublicSummary(limit(publicSummary, 500));
        step.setStartedAt(LocalDateTime.now());
        stepMapper.insert(step);
        return step;
    }

    @Override
    @Transactional
    public void completeStep(AiAgentStep step, String publicSummary, String outputSummary) {
        if (step == null) {
            return;
        }
        step.setStatus("DONE");
        step.setPublicSummary(limit(publicSummary, 500));
        step.setOutputSummary(limit(outputSummary, 1000));
        step.setCompletedAt(LocalDateTime.now());
        stepMapper.updateById(step);
    }

    @Override
    @Transactional
    public void skipStep(Long runId, String agentType, int order, String publicSummary) {
        skipStep(runId, null, agentType, order, publicSummary);
    }

    @Override
    @Transactional
    public void skipStep(Long runId, Long taskId, String agentType, int order, String publicSummary) {
        AiAgentStep step = new AiAgentStep();
        step.setRunId(runId);
        step.setTaskId(taskId);
        step.setAgentType(agentType);
        step.setStepOrder(order);
        step.setAttemptNo(1);
        step.setStatus("SKIPPED");
        step.setPublicSummary(limit(publicSummary, 500));
        step.setCompletedAt(LocalDateTime.now());
        stepMapper.insert(step);
    }

    @Override
    @Transactional
    public void errorStep(AiAgentStep step, Exception error) {
        if (step == null) {
            return;
        }
        step.setStatus("ERROR");
        step.setErrorMessage(limit(errorMessage(error), 500));
        step.setCompletedAt(LocalDateTime.now());
        stepMapper.updateById(step);
    }

    @Override
    @Transactional
    public AiAgentArtifact createArtifact(Long runId, Long stepId, String artifactType, String title,
                                          Map<String, Object> content, Long sourceMessageId) {
        AiAgentArtifact artifact = new AiAgentArtifact();
        artifact.setRunId(runId);
        artifact.setStepId(stepId);
        artifact.setArtifactType(artifactType);
        artifact.setTitle(limit(title, 180));
        artifact.setContentJson(toJson(content == null ? Map.of() : content));
        artifact.setStatus("DRAFT");
        artifact.setSourceMessageId(sourceMessageId);
        artifactMapper.insert(artifact);
        return artifact;
    }

    @Override
    @Transactional
    public void completeRun(AiAgentRun run, AiMessage assistantMessage) {
        if (run == null) {
            return;
        }
        run.setAssistantMessageId(assistantMessage == null ? run.getAssistantMessageId() : assistantMessage.getId());
        run.setStatus("DONE");
        run.setCompletedAt(LocalDateTime.now());
        run.setErrorMessage(null);
        runMapper.updateById(run);
    }

    @Override
    @Transactional
    public void errorRun(AiAgentRun run, Exception error) {
        if (run == null) {
            return;
        }
        run.setStatus("ERROR");
        run.setCompletedAt(LocalDateTime.now());
        run.setErrorMessage(limit(errorMessage(error), 500));
        runMapper.updateById(run);
    }

    @Override
    public Map<String, Object> getRun(Long userId, Long runId) {
        AiAgentRun run = ownedRun(userId, runId);
        return runRow(run, true);
    }

    @Override
    public List<Map<String, Object>> listRuns(Long userId, Long notebookId) {
        LambdaQueryWrapper<AiAgentRun> query = new LambdaQueryWrapper<AiAgentRun>()
                .eq(AiAgentRun::getUserId, userId)
                .orderByDesc(AiAgentRun::getCreatedAt)
                .last("LIMIT 50");
        if (notebookId != null) {
            query.eq(AiAgentRun::getNotebookId, notebookId);
        }
        return runMapper.selectList(query).stream().map(run -> runRow(run, false)).toList();
    }

    @Override
    @Transactional
    public Map<String, Object> confirmArtifact(Long userId, Long id) {
        AiAgentArtifact artifact = artifactMapper.selectByIdForUpdate(id);
        if (artifact == null) {
            throw new BusinessException("草稿不存在");
        }
        AiAgentRun run = ownedRun(userId, artifact.getRunId());
        if ("CONFIRMED".equals(artifact.getStatus())) {
            return artifactRow(artifact, run);
        }
        if (!"DRAFT".equals(artifact.getStatus())) {
            throw new BusinessException("该草稿不能确认");
        }
        if ("WIKI_DRAFT".equals(artifact.getArtifactType())) {
            KnowledgePatchSet patchSet = ensureWikiPatchSet(userId, artifact, run);
            artifact.setTargetType("WIKI_PATCH_SET");
            artifact.setTargetId(patchSet.getId());
        } else if ("PLAN_DRAFT".equals(artifact.getArtifactType())
                || "TASK_DRAFT".equals(artifact.getArtifactType())
                || "ROUTINE_DRAFT".equals(artifact.getArtifactType())) {
            Map<String, Object> result = confirmPlanArtifact(userId, artifact);
            artifact.setContentJson(toJson(merge(parseMap(artifact.getContentJson()), Map.of("confirmResult", result))));
            artifact.setTargetType(text(result.get("targetType"), "PLAN_BATCH"));
            artifact.setTargetId(parseLong(result.get("targetId"), artifact.getId()));
        } else {
            artifact.setTargetType(artifact.getArtifactType());
            artifact.setTargetId(artifact.getId());
        }
        artifact.setStatus("CONFIRMED");
        artifactMapper.updateById(artifact);
        return artifactRow(artifactMapper.selectById(id), run);
    }

    private Map<String, Object> confirmPlanArtifact(Long userId, AiAgentArtifact artifact) {
        Map<String, Object> content = parseMap(artifact.getContentJson());
        List<Map<String, Object>> tasks = mapList(firstNonNull(content.get("tasks"), content.get("suggestedTasks")));
        List<Map<String, Object>> routines = mapList(firstNonNull(content.get("routines"), content.get("suggestedRoutines")));
        if ("TASK_DRAFT".equals(artifact.getArtifactType()) && tasks.isEmpty()) {
            tasks = List.of(content);
        }
        if ("ROUTINE_DRAFT".equals(artifact.getArtifactType()) && routines.isEmpty()) {
            routines = List.of(content);
        }

        List<Long> taskIds = new ArrayList<>();
        List<Long> routineIds = new ArrayList<>();
        List<Map<String, Object>> failures = new ArrayList<>();

        for (Map<String, Object> task : tasks) {
            try {
                TaskCreateRequest request = toTaskCreateRequest(task);
                if (request.getRepeatWeeks() != null && request.getRepeatWeeks() > 1 && request.getStartTime() != null) {
                    List<StudyTask> created = studyTaskService.createRepeated(userId, request);
                    for (StudyTask item : created) {
                        taskIds.add(item.getId());
                    }
                } else {
                    taskIds.add(studyTaskService.create(userId, request).getId());
                }
            } catch (Exception e) {
                failures.add(Map.of(
                        "type", "TASK",
                        "title", text(task.get("title"), "Untitled task"),
                        "error", limit(errorMessage(e), 300)
                ));
            }
        }

        for (Map<String, Object> routine : routines) {
            try {
                Map<String, Object> body = new LinkedHashMap<>(routine);
                body.put("title", text(body.get("title"), "AI routine"));
                routineIds.add(routineService.create(userId, body).getId());
            } catch (Exception e) {
                failures.add(Map.of(
                        "type", "ROUTINE",
                        "title", text(routine.get("title"), "Untitled routine"),
                        "error", limit(errorMessage(e), 300)
                ));
            }
        }

        int requestedCount = tasks.size() + routines.size();
        int createdCount = taskIds.size() + routineIds.size();
        if (requestedCount == 0) {
            throw new BusinessException("No task or routine draft found.");
        }
        if (createdCount == 0) {
            throw new BusinessException("No draft item was created successfully.");
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("createdTasks", taskIds.size());
        result.put("createdRoutines", routineIds.size());
        result.put("taskIds", taskIds);
        result.put("routineIds", routineIds);
        result.put("failures", failures);
        if (taskIds.size() == 1 && routineIds.isEmpty()) {
            result.put("targetType", "TASK");
            result.put("targetId", taskIds.get(0));
        } else if (routineIds.size() == 1 && taskIds.isEmpty()) {
            result.put("targetType", "ROUTINE");
            result.put("targetId", routineIds.get(0));
        } else {
            result.put("targetType", "PLAN_BATCH");
            result.put("targetId", artifact.getId());
        }
        return result;
    }

    private TaskCreateRequest toTaskCreateRequest(Map<String, Object> item) {
        TaskCreateRequest request = new TaskCreateRequest();
        request.setTitle(text(item.get("title"), "AI task"));
        request.setDescription(text(item.get("description"), null));
        request.setQuadrant(clamp(parseInteger(firstNonNull(item.get("quadrant"), item.get("suggestedQuadrant")), 2), 1, 4));
        request.setPriority(clamp(parseInteger(item.get("priority"), 1), 0, 3));
        request.setStatus(clamp(parseInteger(item.get("status"), 0), 0, 2));
        request.setStartTime(parseDateTime(item.get("startTime")));
        request.setDurationMinutes(parseInteger(item.get("durationMinutes"), null));
        request.setRepeatWeeks(parseInteger(item.get("repeatWeeks"), null));
        request.setTaskType(text(item.get("taskType"), null));
        request.setDifficulty(clamp(parseInteger(item.get("difficulty"), 3), 1, 5));
        request.setAiReminderReason(text(firstNonNull(item.get("aiReminderReason"), item.get("reminderReason")), null));
        request.setReminderOffsets(parseIntegerList(firstNonNull(item.get("reminderOffsets"), item.get("suggestedReminderOffsets"))));
        request.setDeadline(parseDateTime(item.get("deadline")));
        request.setReminderTime(parseDateTime(item.get("reminderTime")));
        return request;
    }

    @Override
    @Transactional
    public Map<String, Object> discardArtifact(Long userId, Long id) {
        AiAgentArtifact artifact = artifactMapper.selectByIdForUpdate(id);
        if (artifact == null) {
            throw new BusinessException("草稿不存在");
        }
        AiAgentRun run = ownedRun(userId, artifact.getRunId());
        if (!"CONFIRMED".equals(artifact.getStatus())) {
            artifact.setStatus("DISCARDED");
            artifactMapper.updateById(artifact);
        }
        return artifactRow(artifactMapper.selectById(id), run);
    }

    private AiNotebookSource createSourceShell(Long userId, Long notebookId, String sourceType, String title,
                                               String url, String filePath) {
        AiNotebookSource source = new AiNotebookSource();
        source.setUserId(userId);
        source.setNotebookId(notebookId);
        source.setSourceType(sourceType);
        source.setTitle(title);
        source.setUrl(url);
        source.setFilePath(filePath);
        source.setStatus("UPLOADED");
        sourceMapper.insert(source);
        return source;
    }

    private void writeChunks(AiNotebookSource source, String content, Map<String, Object> metadata) {
        String text = content == null ? "" : content.trim();
        if (text.isBlank()) {
            throw new BusinessException("资料内容为空，无法解析");
        }
        int index = 0;
        for (String chunk : splitChunks(text)) {
            AiSourceChunk entity = new AiSourceChunk();
            entity.setSourceId(source.getId());
            entity.setKnowledgeSourceId(source.getKnowledgeSourceId());
            entity.setChunkIndex(index++);
            entity.setContent(chunk);
            entity.setMetadataJson(toJson(metadata == null ? Map.of() : metadata));
            chunkMapper.insert(entity);
        }
    }

    private List<String> splitChunks(String text) {
        List<String> chunks = new ArrayList<>();
        int start = 0;
        while (start < text.length()) {
            int end = Math.min(text.length(), start + CHUNK_SIZE);
            chunks.add(text.substring(start, end));
            if (end >= text.length()) {
                break;
            }
            start = Math.max(end - CHUNK_OVERLAP, start + 1);
        }
        return chunks;
    }

    private String extractFileText(MultipartFile file) throws Exception {
        String contentType = file.getContentType();
        String fileName = file.getOriginalFilename() == null ? "" : file.getOriginalFilename();
        if (FileParseUtil.isPdf(contentType)) {
            return FileParseUtil.extractPdfText(file);
        }
        if (FileParseUtil.isExcel(contentType, fileName)) {
            return FileParseUtil.extractExcelText(file);
        }
        if (FileParseUtil.isText(contentType, fileName)) {
            return new String(file.getBytes(), StandardCharsets.UTF_8);
        }
        throw new BusinessException("当前 Notebook v1 仅支持 PDF、Excel、CSV、Markdown、JSON 和文本资料");
    }

    private String inferSourceType(String contentType, String fileName) {
        if (FileParseUtil.isPdf(contentType)) return "PDF";
        if (FileParseUtil.isExcel(contentType, fileName)) return "EXCEL";
        return "TEXT";
    }

    private List<Map<String, Object>> wikiContext(Long userId, Map<String, Object> contextOptions) {
        List<Long> selectedIds = longList(contextOptions.get("selectedWikiPageIds"));
        if (selectedIds.isEmpty()) {
            return List.of();
        }
        List<UserKnowledgePage> pages = knowledgePageMapper.selectList(new LambdaQueryWrapper<UserKnowledgePage>()
                .eq(UserKnowledgePage::getUserId, userId)
                .in(UserKnowledgePage::getId, selectedIds));
        if (pages.size() != selectedIds.size()) {
            throw new BusinessException("选择的 Wiki 页面不存在或无权限访问");
        }
        List<Map<String, Object>> rows = new ArrayList<>();
        for (UserKnowledgePage page : pages) {
            rows.add(Map.of(
                    "sourceId", "wiki:" + page.getId(),
                    "title", page.getTitle(),
                    "sourceType", "WIKI_PAGE",
                    "chunkIndex", 0,
                    "content", limit(text(page.getContentSummary(), page.getTitle()), 1600)
            ));
        }
        return rows;
    }

    private KnowledgePatchSet ensureWikiPatchSet(Long userId, AiAgentArtifact artifact, AiAgentRun run) {
        if ("WIKI_PATCH_SET".equals(artifact.getTargetType()) && artifact.getTargetId() != null) {
            KnowledgePatchSet existing = knowledgePatchSetMapper.selectOne(new LambdaQueryWrapper<KnowledgePatchSet>()
                    .eq(KnowledgePatchSet::getUserId, userId)
                    .eq(KnowledgePatchSet::getId, artifact.getTargetId()));
            if (existing != null) {
                return existing;
            }
        }
        Map<String, Object> content = parseMap(artifact.getContentJson());
        String title = limit(text(content.get("title"), artifact.getTitle()), 120);
        String body = limit(text(content.get("content"), text(content.get("markdown"), artifact.getTitle())), 5000);
        Long sourceMessageId = artifact.getSourceMessageId();
        KnowledgePatchSet pending = null;
        if (sourceMessageId != null) {
            pending = knowledgePatchSetMapper.selectOne(new LambdaQueryWrapper<KnowledgePatchSet>()
                    .eq(KnowledgePatchSet::getUserId, userId)
                    .eq(KnowledgePatchSet::getSourceMessageId, sourceMessageId)
                    .eq(KnowledgePatchSet::getStatus, "PENDING")
                    .eq(KnowledgePatchSet::getTriggerType, "AGENT")
                    .last("LIMIT 1"));
        }
        if (pending != null) {
            return pending;
        }

        KnowledgeSource source = new KnowledgeSource();
        source.setUserId(userId);
        source.setSourceType("AGENT");
        source.setTitle("Agent 草稿来源：" + title);
        source.setSourceRef("agent-run:" + run.getId() + "/artifact:" + artifact.getId());
        source.setEncryptedContent(cryptoService.encrypt(body));
        source.setEncryptionVersion("v1");
        source.setContentSummary(limit(body.replaceAll("\\s+", " "), 780));
        source.setMessageId(sourceMessageId);
        source.setImmutableHash(sha256(source.getSourceRef() + "\n" + body));
        knowledgeSourceMapper.insert(source);

        KnowledgePatchSet patchSet = new KnowledgePatchSet();
        patchSet.setUserId(userId);
        patchSet.setTitle(title);
        patchSet.setSummary(limit(body.replaceAll("\\s+", " "), 900));
        patchSet.setStatus("PENDING");
        patchSet.setTriggerType("AGENT");
        patchSet.setSourceMessageId(sourceMessageId);
        knowledgePatchSetMapper.insert(patchSet);

        UserKnowledgeRevision revision = new UserKnowledgeRevision();
        revision.setUserId(userId);
        revision.setPatchSetId(patchSet.getId());
        revision.setActionType("UPSERT");
        revision.setTitle(title);
        revision.setEncryptedContent(cryptoService.encrypt(body));
        revision.setEncryptionVersion("v1");
        revision.setStatus("PENDING");
        revision.setSourceMessageId(sourceMessageId);
        knowledgeRevisionMapper.insert(revision);
        return patchSet;
    }

    private AiNotebook ownedNotebook(Long userId, Long id) {
        if (id == null) {
            throw new BusinessException("Notebook 不存在");
        }
        AiNotebook notebook = notebookMapper.selectOne(new LambdaQueryWrapper<AiNotebook>()
                .eq(AiNotebook::getUserId, userId)
                .eq(AiNotebook::getId, id));
        if (notebook == null) {
            throw new BusinessException("Notebook 不存在或无权限访问");
        }
        return notebook;
    }

    private AiAgentRun ownedRun(Long userId, Long id) {
        if (id == null) {
            throw new BusinessException("AgentRun 不存在");
        }
        AiAgentRun run = runMapper.selectOne(new LambdaQueryWrapper<AiAgentRun>()
                .eq(AiAgentRun::getUserId, userId)
                .eq(AiAgentRun::getId, id));
        if (run == null) {
            throw new BusinessException("AgentRun 不存在或无权限访问");
        }
        return run;
    }

    private Long resolveNotebookId(Long userId, Long notebookId) {
        return notebookId == null ? ensureDefaultNotebook(userId).getId() : ownedNotebook(userId, notebookId).getId();
    }

    private Map<String, Object> notebookRow(AiNotebook notebook) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", notebook.getId());
        row.put("title", notebook.getTitle());
        row.put("description", notebook.getDescription());
        row.put("status", notebook.getStatus());
        row.put("createdAt", notebook.getCreatedAt());
        row.put("updatedAt", notebook.getUpdatedAt());
        row.put("sourceCount", sourceMapper.selectCount(new LambdaQueryWrapper<AiNotebookSource>()
                .eq(AiNotebookSource::getNotebookId, notebook.getId())
                .eq(AiNotebookSource::getUserId, notebook.getUserId())));
        return row;
    }

    private Map<String, Object> sourceRow(AiNotebookSource source) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", source.getId());
        row.put("notebookId", source.getNotebookId());
        row.put("knowledgeSourceId", source.getKnowledgeSourceId());
        row.put("sourceType", source.getSourceType());
        row.put("title", source.getTitle());
        row.put("url", source.getUrl());
        row.put("status", source.getStatus());
        row.put("parseError", source.getParseError());
        row.put("hasFile", source.getFilePath() != null && !source.getFilePath().isBlank());
        row.put("createdAt", source.getCreatedAt());
        row.put("updatedAt", source.getUpdatedAt());
        row.put("chunkCount", chunkMapper.selectCount(new LambdaQueryWrapper<AiSourceChunk>()
                .eq(AiSourceChunk::getSourceId, source.getId())));
        return row;
    }

    private Map<String, Object> runRow(AiAgentRun run, boolean details) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", run.getId());
        row.put("userMessageId", run.getUserMessageId());
        row.put("assistantMessageId", run.getAssistantMessageId());
        row.put("notebookId", run.getNotebookId());
        row.put("status", run.getStatus());
        row.put("agentMode", run.getAgentMode());
        row.put("contextOptions", parseMap(run.getContextOptionsJson()));
        row.put("executionMode", run.getExecutionMode());
        row.put("maxSteps", run.getMaxSteps());
        row.put("maxParallelTasks", run.getMaxParallelTasks());
        row.put("timeoutSeconds", run.getTimeoutSeconds());
        row.put("createdAt", run.getCreatedAt());
        row.put("completedAt", run.getCompletedAt());
        row.put("errorMessage", run.getErrorMessage());
        if (details) {
            row.put("tasks", taskGraphService.listTaskRows(run.getId()));
            row.put("steps", stepMapper.selectList(new LambdaQueryWrapper<AiAgentStep>()
                    .eq(AiAgentStep::getRunId, run.getId())
                    .orderByAsc(AiAgentStep::getStepOrder)
                    .orderByAsc(AiAgentStep::getId)).stream().map(this::stepRow).toList());
            row.put("artifacts", artifactMapper.selectList(new LambdaQueryWrapper<AiAgentArtifact>()
                    .eq(AiAgentArtifact::getRunId, run.getId())
                    .orderByAsc(AiAgentArtifact::getId)).stream().map(item -> artifactRow(item, run)).toList());
            row.put("claims", blackboardService.listClaimRows(run.getId()));
            row.put("evidence", blackboardService.listEvidenceRows(run.getId()));
            row.put("verifierFindings", blackboardService.listFindingRows(run.getId()));
        }
        return row;
    }

    private Map<String, Object> stepRow(AiAgentStep step) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", step.getId());
        row.put("runId", step.getRunId());
        row.put("taskId", step.getTaskId());
        row.put("agentType", step.getAgentType());
        row.put("stepOrder", step.getStepOrder());
        row.put("parallelGroupId", step.getParallelGroupId());
        row.put("attemptNo", step.getAttemptNo());
        row.put("status", step.getStatus());
        row.put("publicSummary", step.getPublicSummary());
        row.put("errorMessage", step.getErrorMessage());
        row.put("startedAt", step.getStartedAt());
        row.put("completedAt", step.getCompletedAt());
        return row;
    }

    private Map<String, Object> artifactRow(AiAgentArtifact artifact, AiAgentRun run) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", artifact.getId());
        row.put("runId", artifact.getRunId());
        row.put("stepId", artifact.getStepId());
        row.put("artifactType", artifact.getArtifactType());
        row.put("title", artifact.getTitle());
        row.put("content", parseMap(artifact.getContentJson()));
        row.put("status", artifact.getStatus());
        row.put("targetType", artifact.getTargetType());
        row.put("targetId", artifact.getTargetId());
        row.put("sourceMessageId", artifact.getSourceMessageId());
        row.put("createdAt", artifact.getCreatedAt());
        row.put("updatedAt", artifact.getUpdatedAt());
        return row;
    }

    private String normalizeAgentMode(String mode) {
        String value = text(mode, "AUTO").toUpperCase(Locale.ROOT);
        return Set.of("AUTO", "CHAT_ONLY", "RESEARCH", "PLAN").contains(value) ? value : "AUTO";
    }

    private List<Long> longList(Object value) {
        if (!(value instanceof List<?> list)) {
            return List.of();
        }
        List<Long> result = new ArrayList<>();
        for (Object item : list) {
            try {
                result.add(Long.parseLong(String.valueOf(item)));
            } catch (Exception ignored) {
            }
        }
        return result;
    }

    private List<Map<String, Object>> sortContextRows(List<Map<String, Object>> rows, String query) {
        if (rows == null || rows.size() <= 1 || query == null || query.isBlank()) {
            return rows == null ? List.of() : rows;
        }
        List<String> terms = queryTerms(query);
        if (terms.isEmpty()) {
            return rows;
        }
        List<Map<String, Object>> sorted = new ArrayList<>(rows);
        sorted.sort(Comparator
                .comparingInt((Map<String, Object> row) -> scoreContextRow(row, terms))
                .reversed()
                .thenComparing(row -> String.valueOf(row.getOrDefault("title", ""))));
        return sorted;
    }

    private List<String> queryTerms(String query) {
        String normalized = query.toLowerCase(Locale.ROOT)
                .replaceAll("[^\\p{IsHan}a-z0-9]+", " ")
                .trim();
        if (normalized.isBlank()) {
            return List.of();
        }
        List<String> result = new ArrayList<>();
        for (String term : normalized.split("\\s+")) {
            if (term.length() >= 2 && !result.contains(term)) {
                result.add(term);
            }
        }
        return result.size() > 12 ? result.subList(0, 12) : result;
    }

    private int scoreContextRow(Map<String, Object> row, List<String> terms) {
        String haystack = (String.valueOf(row.getOrDefault("title", "")) + "\n"
                + String.valueOf(row.getOrDefault("content", ""))).toLowerCase(Locale.ROOT);
        int score = 0;
        for (String term : terms) {
            if (haystack.contains(term)) {
                score++;
            }
        }
        return score;
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> mapList(Object value) {
        if (!(value instanceof List<?> list)) {
            return List.of();
        }
        List<Map<String, Object>> result = new ArrayList<>();
        for (Object item : list) {
            if (item instanceof Map<?, ?> map) {
                Map<String, Object> row = new LinkedHashMap<>();
                for (Map.Entry<?, ?> entry : map.entrySet()) {
                    if (entry.getKey() != null) {
                        row.put(String.valueOf(entry.getKey()), entry.getValue());
                    }
                }
                result.add(row);
            }
        }
        return result;
    }

    private Object firstNonNull(Object first, Object second) {
        return first != null ? first : second;
    }

    private Integer parseInteger(Object value, Integer fallback) {
        if (value == null || String.valueOf(value).isBlank()) {
            return fallback;
        }
        try {
            return Integer.parseInt(String.valueOf(value).trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private Long parseLong(Object value, Long fallback) {
        if (value == null || String.valueOf(value).isBlank()) {
            return fallback;
        }
        try {
            return Long.parseLong(String.valueOf(value).trim());
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private int clamp(Integer value, int min, int max) {
        int safeValue = value == null ? min : value;
        return Math.max(min, Math.min(max, safeValue));
    }

    private LocalDateTime parseDateTime(Object value) {
        if (value == null || String.valueOf(value).isBlank()) {
            return null;
        }
        String text = String.valueOf(value).trim();
        try {
            return LocalDateTime.parse(text, DATE_TIME_FORMATTER);
        } catch (DateTimeParseException ignored) {
        }
        try {
            return LocalDateTime.parse(text);
        } catch (DateTimeParseException ignored) {
        }
        try {
            return LocalDate.parse(text).atTime(23, 59);
        } catch (DateTimeParseException ignored) {
            return null;
        }
    }

    private List<Integer> parseIntegerList(Object value) {
        List<Integer> result = new ArrayList<>();
        if (value == null) {
            return result;
        }
        if (value instanceof List<?> list) {
            for (Object item : list) {
                Integer parsed = parseInteger(item, null);
                if (parsed != null && parsed >= 0 && parsed <= 365 && !result.contains(parsed)) {
                    result.add(parsed);
                }
            }
            return result;
        }
        for (String part : String.valueOf(value).split(",")) {
            Integer parsed = parseInteger(part.trim(), null);
            if (parsed != null && parsed >= 0 && parsed <= 365 && !result.contains(parsed)) {
                result.add(parsed);
            }
        }
        return result;
    }

    private Map<String, Object> merge(Map<String, Object> base, Map<String, Object> extra) {
        Map<String, Object> result = new LinkedHashMap<>();
        if (base != null) {
            result.putAll(base);
        }
        if (extra != null) {
            result.putAll(extra);
        }
        return result;
    }

    private Map<String, Object> parseMap(String json) {
        if (json == null || json.isBlank()) {
            return new LinkedHashMap<>();
        }
        try {
            return objectMapper.readValue(json, new TypeReference<LinkedHashMap<String, Object>>() {});
        } catch (Exception e) {
            return new LinkedHashMap<>();
        }
    }

    private String toJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (Exception e) {
            return "{}";
        }
    }

    private String text(Object value, String fallback) {
        String result = value == null ? "" : String.valueOf(value).trim();
        return result.isBlank() ? fallback : result;
    }

    private String limit(String value, int max) {
        String text = value == null ? "" : value;
        return text.length() <= max ? text : text.substring(0, max);
    }

    private String errorMessage(Exception e) {
        return e == null || e.getMessage() == null ? "处理失败" : e.getMessage();
    }

    private String sha256(String text) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(String.valueOf(text).getBytes(StandardCharsets.UTF_8));
            StringBuilder builder = new StringBuilder();
            for (byte item : bytes) {
                builder.append(String.format("%02x", item));
            }
            return builder.toString();
        } catch (Exception e) {
            return Integer.toHexString(String.valueOf(text).hashCode());
        }
    }
}
