package com.zhiqu.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.AiModelConfig;
import com.zhiqu.entity.AiConversation;
import com.zhiqu.entity.AiAgentArtifact;
import com.zhiqu.entity.AiAgentClaim;
import com.zhiqu.entity.AiAgentEvidence;
import com.zhiqu.entity.AiAgentRun;
import com.zhiqu.entity.AiAgentStep;
import com.zhiqu.entity.AiAgentTask;
import com.zhiqu.entity.AiMessage;
import com.zhiqu.entity.AiVerifierFinding;
import com.zhiqu.entity.KnowledgePatchSet;
import com.zhiqu.entity.KnowledgeSource;
import com.zhiqu.entity.UserAiConfig;
import com.zhiqu.entity.UserAiMemory;
import com.zhiqu.entity.UserKnowledgePage;
import com.zhiqu.entity.UserKnowledgeRevision;
import com.zhiqu.mapper.AiModelConfigMapper;
import com.zhiqu.mapper.AiConversationMapper;
import com.zhiqu.mapper.AiMessageMapper;
import com.zhiqu.mapper.KnowledgePatchSetMapper;
import com.zhiqu.mapper.KnowledgeSourceMapper;
import com.zhiqu.mapper.UserAiConfigMapper;
import com.zhiqu.mapper.UserAiMemoryMapper;
import com.zhiqu.mapper.UserKnowledgePageMapper;
import com.zhiqu.mapper.UserKnowledgeRevisionMapper;
import com.zhiqu.service.AgentBlackboardService;
import com.zhiqu.service.AgentTaskGraphService;
import com.zhiqu.service.AiService;
import com.zhiqu.service.AiWorkspaceService;
import com.zhiqu.service.MultiAgentOrchestrator;
import com.zhiqu.service.ReminderPlanService;
import com.zhiqu.service.VerifierService;
import com.zhiqu.service.ai.WebResearchService;
import com.zhiqu.service.ai.WebSearchProvider;
import com.zhiqu.service.ai.stream.ModelStreamAdapterFactory;
import com.zhiqu.service.ai.stream.ModelStreamRequest;
import com.zhiqu.service.ai.stream.ModelStreamResult;
import com.zhiqu.service.ai.stream.NormalizedStreamEvent;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.math.BigDecimal;
import java.net.InetAddress;
import java.net.URI;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.*;
import java.util.concurrent.CompletableFuture;

@Service
public class AiServiceImpl implements AiService {

    private static final Logger log = LoggerFactory.getLogger(AiServiceImpl.class);
    private static final String DEFAULT_CONVERSATION_KEY = "default";
    private static final int CHAT_HISTORY_LIMIT = 20;
    private static final int MEMORY_MAX_LENGTH = 2000;
    private static final int MESSAGE_MAX_LENGTH = 12000;
    private static final long SYSTEM_MODEL_ID = -1L;
    private static final String PROBE_IMAGE_BASE64 =
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

    private record AiCallResult(String content, String reasoningSummary) {
    }

    private final UserAiConfigMapper configMapper;
    private final AiModelConfigMapper modelConfigMapper;
    private final AiConversationMapper conversationMapper;
    private final AiMessageMapper messageMapper;
    private final UserAiMemoryMapper memoryMapper;
    private final UserKnowledgePageMapper knowledgePageMapper;
    private final UserKnowledgeRevisionMapper knowledgeRevisionMapper;
    private final KnowledgePatchSetMapper knowledgePatchSetMapper;
    private final KnowledgeSourceMapper knowledgeSourceMapper;
    private final ReminderPlanService reminderPlanService;
    private final AiWorkspaceService aiWorkspaceService;
    private final AgentTaskGraphService agentTaskGraphService;
    private final AgentBlackboardService agentBlackboardService;
    private final VerifierService verifierService;
    private final MultiAgentOrchestrator multiAgentOrchestrator;
    private final WebSearchProvider webSearchProvider;
    private final WebResearchService webResearchService;
    private final ModelStreamAdapterFactory modelStreamAdapterFactory;
    private final SensitiveCryptoService cryptoService;
    private final RestTemplate restTemplate;
    private final ObjectMapper objectMapper;
    private final boolean systemDefaultEnabled;
    private final String systemDisplayName;
    private final String systemProviderType;
    private final String systemApiUrl;
    private final String systemModelName;
    private final String systemApiKey;
    private final String anthropicVersion;
    private final boolean streamDebug;
    private final boolean allowPrivateProviderUrl;

    public AiServiceImpl(UserAiConfigMapper configMapper,
                         AiModelConfigMapper modelConfigMapper,
                         AiConversationMapper conversationMapper,
                         AiMessageMapper messageMapper,
                         UserAiMemoryMapper memoryMapper,
                         UserKnowledgePageMapper knowledgePageMapper,
                         UserKnowledgeRevisionMapper knowledgeRevisionMapper,
                         KnowledgePatchSetMapper knowledgePatchSetMapper,
                         KnowledgeSourceMapper knowledgeSourceMapper,
                         ReminderPlanService reminderPlanService,
                         AiWorkspaceService aiWorkspaceService,
                         AgentTaskGraphService agentTaskGraphService,
                         AgentBlackboardService agentBlackboardService,
                         VerifierService verifierService,
                         MultiAgentOrchestrator multiAgentOrchestrator,
                         WebSearchProvider webSearchProvider,
                         WebResearchService webResearchService,
                         ModelStreamAdapterFactory modelStreamAdapterFactory,
                         SensitiveCryptoService cryptoService,
                         @Value("${app.ai.system-default-enabled:false}") boolean systemDefaultEnabled,
                         @Value("${app.ai.system-display-name:知趣默认模型}") String systemDisplayName,
                         @Value("${app.ai.system-provider-type:OPENAI_COMPATIBLE}") String systemProviderType,
                         @Value("${app.ai.system-api-url:https://api.openai.com/v1/chat/completions}") String systemApiUrl,
                         @Value("${app.ai.system-model-name:gpt-4o-mini}") String systemModelName,
                         @Value("${app.ai.system-api-key:}") String systemApiKey,
                         @Value("${app.ai.anthropic-version:2023-06-01}") String anthropicVersion,
                         @Value("${app.ai.stream.debug:false}") boolean streamDebug,
                         @Value("${app.ai.allow-private-provider-url:false}") boolean allowPrivateProviderUrl) {
        this.configMapper = configMapper;
        this.modelConfigMapper = modelConfigMapper;
        this.conversationMapper = conversationMapper;
        this.messageMapper = messageMapper;
        this.memoryMapper = memoryMapper;
        this.knowledgePageMapper = knowledgePageMapper;
        this.knowledgeRevisionMapper = knowledgeRevisionMapper;
        this.knowledgePatchSetMapper = knowledgePatchSetMapper;
        this.knowledgeSourceMapper = knowledgeSourceMapper;
        this.reminderPlanService = reminderPlanService;
        this.aiWorkspaceService = aiWorkspaceService;
        this.agentTaskGraphService = agentTaskGraphService;
        this.agentBlackboardService = agentBlackboardService;
        this.verifierService = verifierService;
        this.multiAgentOrchestrator = multiAgentOrchestrator;
        this.webSearchProvider = webSearchProvider;
        this.webResearchService = webResearchService;
        this.modelStreamAdapterFactory = modelStreamAdapterFactory;
        this.cryptoService = cryptoService;
        this.restTemplate = createAiRestTemplate();
        this.objectMapper = new ObjectMapper();
        this.systemDefaultEnabled = systemDefaultEnabled;
        this.systemDisplayName = systemDisplayName;
        this.systemProviderType = systemProviderType;
        this.systemApiUrl = systemApiUrl;
        this.systemModelName = systemModelName;
        this.systemApiKey = systemApiKey;
        this.anthropicVersion = anthropicVersion;
        this.streamDebug = streamDebug;
        this.allowPrivateProviderUrl = allowPrivateProviderUrl;
    }

    private RestTemplate createAiRestTemplate() {
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(10_000);
        factory.setReadTimeout(60_000);
        return new RestTemplate(factory);
    }

    @Override
    public UserAiConfig getConfig(Long userId) {
        ensureLegacyConfigMigrated(userId);
        AiModelConfig model = getDefaultUserModel(userId);
        if (model == null) {
            return null;
        }
        UserAiConfig config = new UserAiConfig();
        config.setUserId(userId);
        config.setApiUrl(model.getApiUrl());
        config.setApiKey(cryptoService.maskSecret(model.getEncryptedApiKey()));
        config.setModelName(model.getModelName());
        return config;
    }

    @Override
    @Transactional
    public void saveConfig(Long userId, String apiUrl, String apiKey, String modelName) {
        Map<String, Object> body = new HashMap<>();
        body.put("displayName", hasText(modelName) ? cleanModelDisplayName(modelName) : "我的 AI 模型");
        body.put("providerType", inferProviderType(apiUrl));
        body.put("apiUrl", apiUrl);
        body.put("apiKey", apiKey);
        body.put("modelName", modelName);
        body.put("capabilities", "TEXT,VISION");
        body.put("isDefault", true);
        AiModelConfig existing = getDefaultUserModel(userId);
        saveModel(userId, existing == null ? null : existing.getId(), body);

        UserAiConfig legacy = configMapper.selectOne(
                new LambdaQueryWrapper<UserAiConfig>().eq(UserAiConfig::getUserId, userId)
        );
        if (legacy != null) {
            legacy.setApiUrl(normalizeProviderApiUrl(stringValue(body.get("apiUrl")), stringValue(body.get("providerType"))));
            legacy.setApiKey(null);
            legacy.setModelName(hasText(modelName) ? modelName.trim() : "gpt-3.5-turbo");
            configMapper.updateById(legacy);
        }
    }

    @Override
    public List<Map<String, Object>> analyzeContent(Long userId, String content, String fileName) {
        AiModelConfig config = requireModel(userId, null);
        String userMessage = "文件名：" + fileName + "\n\n文件内容：\n" + content;
        String aiResponse = callAiApi(config, getAnalyzeSystemPrompt(), userMessage);
        return parseTasksFromResponse(aiResponse);
    }

    @Override
    public List<Map<String, Object>> analyzeImage(Long userId, String base64Image, String mediaType, String fileName) {
        AiModelConfig config = requireModel(userId, null);
        if (!hasCapability(config, "VISION")) {
            throw new BusinessException("当前模型未标记为支持图片识别，请在个人中心切换或添加支持视觉的模型");
        }

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
    public Map<String, Object> chat(Long userId, String message) {
        return chat(userId, message, null);
    }

    @Override
    public Map<String, Object> chat(Long userId, String message, Long modelConfigId) {
        return chat(userId, message, modelConfigId, false, "OFF");
    }

    @Override
    public Map<String, Object> chat(Long userId, String message, Long modelConfigId,
                                    Boolean enableWebSearch, String reasoningMode) {
        AiModelConfig config = requireModel(userId, modelConfigId);
        if (!hasText(message)) {
            throw new BusinessException("消息不能为空");
        }
        String normalizedReasoningMode = normalizeReasoningMode(reasoningMode);
        if (isReasoningRequested(normalizedReasoningMode) && !supportsDeepReasoning(config)) {
            throw new BusinessException("当前模型不支持深度思考，请切换到 DeepSeek Reasoner、OpenAI reasoning 或 Claude thinking 模型");
        }
        AiConversation conversation = getOrCreateDefaultConversation(userId);
        List<AiMessage> history = getRecentMessages(userId, conversation.getId(), CHAT_HISTORY_LIMIT);
        String memoryText = getMemoryText(userId, limitedQuery(message));

        List<Map<String, Object>> messages = new ArrayList<>();
        messages.add(Map.of("role", "system", "content", buildChatSystemPrompt(memoryText)));
        for (AiMessage item : history) {
            if (isChatRole(item.getRole()) && hasText(item.getContent())) {
                messages.add(Map.of("role", normalizeChatRole(item.getRole()), "content", item.getContent()));
            }
        }
        String limitedMessage = limitText(message, MESSAGE_MAX_LENGTH);
        List<WebSearchProvider.SearchResult> citations = Boolean.TRUE.equals(enableWebSearch)
                ? webResearchService.research(limitedMessage, history)
                : List.of();
        Map<String, Object> retrievalStatus = retrievalStatus(citations);
        messages.add(Map.of("role", "user", "content", withWebSearchContext(limitedMessage, citations)));

        AiCallResult aiCallResult = callAiApiDetailed(config, messages, normalizedReasoningMode);
        String reply = aiCallResult.content();
        AiMessage userMessage = saveChatMessage(userId, conversation.getId(), "user", limitedMessage);
        boolean wikiWriteRequested = looksWikiWriteIntent(limitedMessage);
        Map<String, Object> wikiRevision = null;
        String finalReply = reply;
        if (wikiWriteRequested) {
            UserKnowledgeRevision revision = createWikiDraftRevision(
                    userId,
                    conversation.getId(),
                    userMessage.getId(),
                    limitedMessage,
                    reply,
                    history
            );
            wikiRevision = chatWikiRevisionRow(revision);
            finalReply = buildWikiDraftReply(revision, cryptoService.decrypt(revision.getEncryptedContent()));
        } else {
            maybeUpdateLongTermMemory(config, userId, limitedMessage, reply);
        }
        AiMessage assistantMessage = saveChatMessage(
                userId,
                conversation.getId(),
                "assistant",
                limitText(finalReply, MESSAGE_MAX_LENGTH),
                isReasoningRequested(normalizedReasoningMode) ? aiCallResult.reasoningSummary() : "",
                citationRows(citations),
                retrievalStatus,
                Map.of(),
                normalizedReasoningMode,
                Boolean.TRUE.equals(enableWebSearch)
        );
        Map<String, Object> result = new HashMap<>();
        result.put("reply", finalReply);
        result.put("userMessageId", userMessage.getId());
        result.put("assistantMessageId", assistantMessage.getId());
        result.put("citations", citationRows(citations));
        result.put("retrievalStatus", retrievalStatus);
        result.put("usage", Map.of());
        if (isReasoningRequested(normalizedReasoningMode) && hasText(aiCallResult.reasoningSummary())) {
            result.put("reasoningSummary", aiCallResult.reasoningSummary());
        }
        if (wikiRevision != null) {
            result.put("wikiRevision", wikiRevision);
            result.put("wikiPatchSet", Map.of(
                    "id", wikiRevision.get("patchSetId"),
                    "title", wikiRevision.get("title"),
                    "status", "PENDING"
            ));
        }
        Map<String, Object> suggestedPlan = suggestPlanFromChatIfNeeded(config, limitedMessage, reply);
        result.put("suggestedTasks", suggestedPlan.get("tasks"));
        result.put("suggestedRoutines", suggestedPlan.get("routines"));
        return result;
    }

    @Override
    public SseEmitter streamChat(Long userId, String message, Long modelConfigId,
                                 Boolean enableWebSearch, String reasoningMode) {
        return streamChat(userId, message, modelConfigId, enableWebSearch, reasoningMode, null, "AUTO", Map.of());
    }

    @Override
    public SseEmitter streamChat(Long userId, String message, Long modelConfigId,
                                 Boolean enableWebSearch, String reasoningMode,
                                 Long notebookId, String agentMode, Map<String, Object> contextOptions) {
        SseEmitter emitter = new SseEmitter(120_000L);
        CompletableFuture.runAsync(() -> {
            try {
                streamChatInternal(emitter, userId, message, modelConfigId, enableWebSearch, reasoningMode,
                        notebookId, agentMode, contextOptions == null ? Map.of() : contextOptions);
                emitter.complete();
            } catch (Exception e) {
                if (e instanceof BusinessException) {
                    Map<String, Object> error = new LinkedHashMap<>();
                    error.put("message", e.getMessage() == null ? "AI 流式调用失败" : e.getMessage());
                    error.put("nonRetryable", true);
                    emitSse(emitter, "error", error);
                    emitter.complete();
                    return;
                }
                emitSse(emitter, "error", Map.of("message", e.getMessage() == null ? "AI 流式调用失败" : e.getMessage()));
                emitter.complete();
            }
        });
        return emitter;
    }

    private void streamChatInternal(SseEmitter emitter, Long userId, String message, Long modelConfigId,
                                    Boolean enableWebSearch, String reasoningMode,
                                    Long notebookId, String agentMode, Map<String, Object> contextOptions) {
        AiModelConfig config = requireModel(userId, modelConfigId);
        if (!hasText(message)) {
            throw new BusinessException("消息不能为空");
        }
        String normalizedReasoningMode = normalizeReasoningMode(reasoningMode);
        if (isReasoningRequested(normalizedReasoningMode) && !supportsDeepReasoning(config)) {
            throw new BusinessException("当前模型不支持深度思考，请切换到 DeepSeek Reasoner、OpenAI reasoning 或 Claude thinking 模型");
        }
        String limitedMessage = limitText(message, MESSAGE_MAX_LENGTH);
        if (Boolean.TRUE.equals(enableWebSearch) && !webResearchService.canResearch(limitedMessage)) {
            throw new BusinessException("联网搜索需要配置搜索源；如果只想读取网页，请直接在问题里提供 http/https 链接。");
        }
        AiConversation conversation = getOrCreateDefaultConversation(userId);
        List<AiMessage> history = getRecentMessages(userId, conversation.getId(), CHAT_HISTORY_LIMIT);
        String memoryText = getMemoryText(userId, limitedQuery(limitedMessage));
        String requestId = UUID.randomUUID().toString();
        AiMessage userMessage = saveChatMessage(userId, conversation.getId(), "user", limitedMessage);
        AiMessage assistantMessage = createStreamingAssistantMessage(
                userId,
                conversation.getId(),
                requestId,
                config,
                normalizedReasoningMode,
                Boolean.TRUE.equals(enableWebSearch)
        );
        String normalizedAgentMode = normalizeAgentMode(agentMode);
        AiAgentRun agentRun = aiWorkspaceService.beginRun(
                userId,
                notebookId,
                normalizedAgentMode,
                contextOptions,
                userMessage,
                assistantMessage
        );
        emitSse(emitter, "agent.run.start", Map.of(
                "requestId", requestId,
                "runId", agentRun.getId(),
                "agentRunId", agentRun.getId(),
                "status", agentRun.getStatus()
        ));
        Map<String, Object> start = new LinkedHashMap<>();
        start.put("requestId", requestId);
        start.put("agentRunId", agentRun.getId());
        start.put("status", "STREAMING");
        start.put("userMessageId", userMessage.getId());
        start.put("assistantMessageId", assistantMessage.getId());
        emitSse(emitter, "stream.start", start);

        List<AiAgentTask> taskGraph = multiAgentOrchestrator.plan(
                agentRun,
                limitedMessage,
                normalizedAgentMode,
                Boolean.TRUE.equals(enableWebSearch),
                notebookId,
                contextOptions
        );
        for (AiAgentTask task : taskGraph) {
            emitAgentTaskCreated(emitter, requestId, agentRun, task);
        }
        Map<String, AiAgentTask> tasksByAgent = taskMap(taskGraph);
        AiAgentTask orchestratorTask = tasksByAgent.get("ORCHESTRATOR");
        AiAgentTask retrieverTask = firstTask(tasksByAgent, "NOTEBOOK_RESEARCHER", "WIKI_RESEARCHER", "WEB_RESEARCHER", "RETRIEVER");
        AiAgentTask plannerTask = tasksByAgent.get("PLANNER");
        AiAgentTask taskDrafterTask = tasksByAgent.get("TASK_DRAFTER");
        AiAgentTask verifierTask = tasksByAgent.get("VERIFIER");
        AiAgentTask finalWriterTask = tasksByAgent.get("FINAL_WRITER");
        AiAgentTask wikiTask = tasksByAgent.get("WIKI_CURATOR");

        AiAgentStep dispatcherStep = null;
        AiAgentStep retrieverStep = null;
        AiAgentStep plannerStep = null;
        AiAgentStep verifierStep = null;
        AiAgentStep finalWriterStep = null;
        try {
            startTask(emitter, requestId, agentRun, orchestratorTask);
            dispatcherStep = startAgentStep(emitter, requestId, agentRun, orchestratorTask, "DISPATCHER", 1, "正在分析问题");
            boolean retrieverRequired = shouldRunRetriever(normalizedAgentMode, enableWebSearch, notebookId, contextOptions);
            boolean plannerRequired = shouldRunPlanner(normalizedAgentMode, limitedMessage);
            aiWorkspaceService.completeStep(dispatcherStep, "已完成意图分析", "retriever=" + retrieverRequired + ", planner=" + plannerRequired);
            emitAgentStepDone(emitter, requestId, agentRun, dispatcherStep);
            completeTask(emitter, requestId, agentRun, orchestratorTask, Map.of("retriever", retrieverRequired, "planner", plannerRequired), "Task graph ready");

            List<Map<String, Object>> notebookContextRows = List.of();
            List<WebSearchProvider.SearchResult> citations = List.of();
            List<Long> evidenceIds = new ArrayList<>();
            if (retrieverRequired) {
                startResearchTasks(emitter, requestId, agentRun, taskGraph);
                retrieverStep = startAgentStep(emitter, requestId, agentRun, retrieverTask, "RETRIEVER", 2, "正在检索资料来源");
                Map<String, Object> retrievalOptions = new LinkedHashMap<>(contextOptions == null ? Map.of() : contextOptions);
                retrievalOptions.put("query", limitedMessage);
                notebookContextRows = aiWorkspaceService.sourceContext(userId, notebookId, retrievalOptions);
                citations = Boolean.TRUE.equals(enableWebSearch)
                        ? webResearchService.research(limitedMessage, history)
                        : List.of();
            } else {
                aiWorkspaceService.skipStep(agentRun.getId(), "RETRIEVER", 2, "本轮不需要资料检索");
                emitAgentStepSkipped(emitter, requestId, agentRun, "RETRIEVER", 2, "本轮不需要资料检索");
                skipResearchTasks(emitter, requestId, agentRun, taskGraph);
            }
            List<Map<String, Object>> webCitationRows = citationRows(citations);
            Map<String, Object> retrievalStatus = retrievalStatus(citations);
            List<Map<String, Object>> artifactCitationRows = new ArrayList<>();
            artifactCitationRows.addAll(notebookContextRows);
            artifactCitationRows.addAll(webCitationRows);
            if (retrieverStep != null) {
                for (Map<String, Object> item : notebookContextRows) {
                    AiAgentArtifact artifact = aiWorkspaceService.createArtifact(
                            agentRun.getId(),
                            retrieverStep.getId(),
                            "CITATION",
                            stringValue(item.get("title")),
                            item,
                            userMessage.getId()
                    );
                    emitSse(emitter, "artifact.created", artifactEvent(requestId, agentRun, retrieverStep, artifact));
                    AiAgentEvidence evidence = agentBlackboardService.createEvidence(
                            agentRun.getId(),
                            retrieverTask == null ? null : retrieverTask.getId(),
                            retrieverStep.getId(),
                            stringValue(item.get("sourceType")),
                            String.valueOf(item.getOrDefault("sourceId", "")),
                            artifact.getId(),
                            stringValue(item.get("content")),
                            item
                    );
                    evidenceIds.add(evidence.getId());
                    emitSse(emitter, "evidence.created", evidenceEvent(requestId, agentRun, evidence));
                }
            }
            for (Map<String, Object> citation : webCitationRows) {
                emitSse(emitter, "citation", withStreamMeta(citation, requestId, assistantMessage.getId()));
                if (retrieverStep != null) {
                    String artifactType = isSuccessfulCitation(citation) ? "CITATION" : "FAILED_SOURCE";
                    AiAgentArtifact artifact = aiWorkspaceService.createArtifact(
                            agentRun.getId(),
                            retrieverStep.getId(),
                            artifactType,
                            stringValue(citation.get("title")),
                            citation,
                            userMessage.getId()
                    );
                    emitSse(emitter, "artifact.created", artifactEvent(requestId, agentRun, retrieverStep, artifact));
                    if (isSuccessfulCitation(citation)) {
                        AiAgentEvidence evidence = agentBlackboardService.createEvidence(
                                agentRun.getId(),
                                retrieverTask == null ? null : retrieverTask.getId(),
                                retrieverStep.getId(),
                                "WEB_PAGE",
                                stringValue(citation.get("url")),
                                artifact.getId(),
                                stringValue(citation.get("snippet")),
                                citation
                        );
                        evidenceIds.add(evidence.getId());
                        emitSse(emitter, "evidence.created", evidenceEvent(requestId, agentRun, evidence));
                    }
                }
            }
            if (!evidenceIds.isEmpty() && retrieverStep != null) {
                AiAgentClaim claim = agentBlackboardService.createClaim(
                        agentRun.getId(),
                        retrieverStep.getId(),
                        retrieverTask == null ? null : retrieverTask.getId(),
                        "RETRIEVAL_CONTEXT",
                        "Retrieved usable context for the final answer.",
                        BigDecimal.valueOf(0.8),
                        evidenceIds,
                        Map.of("evidenceCount", evidenceIds.size())
                );
                emitSse(emitter, "claim.created", claimEvent(requestId, agentRun, claim));
            }
            if (Boolean.TRUE.equals(enableWebSearch)) {
                emitSse(emitter, "retrieval.status", withStreamMeta(retrievalStatus, requestId, assistantMessage.getId()));
            }
            if (retrieverStep != null) {
                aiWorkspaceService.completeStep(retrieverStep, "资料检索完成", "sources=" + artifactCitationRows.size());
                emitAgentStepDone(emitter, requestId, agentRun, retrieverStep);
                completeResearchTasks(emitter, requestId, agentRun, taskGraph, Map.of("sources", artifactCitationRows.size()));
            }

            if (verifierTask != null) {
                startTask(emitter, requestId, agentRun, verifierTask);
                verifierStep = startAgentStep(emitter, requestId, agentRun, verifierTask, "VERIFIER", 35, "正在校验结果");
                List<AiVerifierFinding> findings = verifierService.verifyRun(agentRun.getId());
                for (AiVerifierFinding finding : findings) {
                    emitSse(emitter, "verifier.finding", findingEvent(requestId, agentRun, finding));
                }
                aiWorkspaceService.completeStep(verifierStep, "校验已完成", "findings=" + findings.size());
                emitAgentStepDone(emitter, requestId, agentRun, verifierStep);
                completeTask(emitter, requestId, agentRun, verifierTask, Map.of("findings", findings.size()), "Verification complete");
                if (verifierService.shouldBlockFinalWrite(findings)) {
                    throw new BusinessException("Verifier blocked final answer.");
                }
            }

            if (plannerRequired) {
                startTask(emitter, requestId, agentRun, plannerTask);
                plannerStep = startAgentStep(emitter, requestId, agentRun, plannerTask, "PLANNER", 3, "正在准备计划草稿");
            } else {
                aiWorkspaceService.skipStep(agentRun.getId(), "PLANNER", 3, "本轮不需要计划草稿");
                emitAgentStepSkipped(emitter, requestId, agentRun, "PLANNER", 3, "本轮不需要计划草稿");
                skipTask(emitter, requestId, agentRun, plannerTask, "Planner skipped");
            }

            List<Map<String, Object>> messages = new ArrayList<>();
            messages.add(Map.of("role", "system", "content", buildChatSystemPrompt(memoryText)));
            for (AiMessage item : history) {
                if (isChatRole(item.getRole()) && hasText(item.getContent())) {
                    messages.add(Map.of("role", normalizeChatRole(item.getRole()), "content", item.getContent()));
                }
            }
            messages.add(Map.of("role", "user", "content",
                    withNotebookContext(withWebSearchContext(limitedMessage, citations), notebookContextRows)));

            StringBuilder reply = new StringBuilder();
            StringBuilder reasoning = new StringBuilder();
            List<Map<String, Object>> allCitationRows = new ArrayList<>(webCitationRows);
            Map<String, Object> usage = new LinkedHashMap<>();
            startTask(emitter, requestId, agentRun, finalWriterTask);
            finalWriterStep = startAgentStep(emitter, requestId, agentRun, finalWriterTask, "FINAL_WRITER", 4, "正在生成最终回答");
            // 注意：增量判空用非空而不是非空白——纯换行增量（"\n\n"）是段落分隔，丢弃会把正文压成一行
            AiCallResult aiCallResult = callAiApiStream(config, messages, normalizedReasoningMode, event -> {
                if ("message.delta".equals(event.type()) && event.text() != null && !event.text().isEmpty()) {
                    reply.append(event.text());
                    emitSse(emitter, "message.delta", Map.of(
                            "requestId", requestId,
                            "agentRunId", agentRun.getId(),
                            "assistantMessageId", assistantMessage.getId(),
                            "text", event.text()
                    ));
                } else if ("reasoning.delta".equals(event.type())) {
                    if (isReasoningRequested(normalizedReasoningMode) && event.text() != null && !event.text().isEmpty()) {
                        reasoning.append(event.text());
                        emitSse(emitter, "reasoning.delta", Map.of(
                                "requestId", requestId,
                                "agentRunId", agentRun.getId(),
                                "assistantMessageId", assistantMessage.getId(),
                                "text", event.text()
                        ));
                    }
                } else if ("citation".equals(event.type()) && event.data() != null && !event.data().isEmpty()) {
                    allCitationRows.add(event.data());
                    emitSse(emitter, "citation", withStreamMeta(event.data(), requestId, assistantMessage.getId()));
                } else if ("usage".equals(event.type()) && event.data() != null && !event.data().isEmpty()) {
                    usage.clear();
                    usage.putAll(event.data());
                    emitSse(emitter, "usage", withStreamMeta(usage, requestId, assistantMessage.getId()));
                }
            });
            if (reply.isEmpty() && hasText(aiCallResult.content())) {
                reply.append(aiCallResult.content());
                emitSse(emitter, "message.delta", Map.of(
                        "requestId", requestId,
                        "agentRunId", agentRun.getId(),
                        "assistantMessageId", assistantMessage.getId(),
                        "text", aiCallResult.content()
                ));
            }
            if (reasoning.isEmpty() && isReasoningRequested(normalizedReasoningMode) && hasText(aiCallResult.reasoningSummary())) {
                reasoning.append(aiCallResult.reasoningSummary());
            }

            String finalReply = limitText(reply.toString(), MESSAGE_MAX_LENGTH);
            String finalReasoningSummary = isReasoningRequested(normalizedReasoningMode)
                    ? limitText(reasoning.toString(), 2000)
                    : "";
            completeAssistantMessage(
                    assistantMessage,
                    finalReply,
                    finalReasoningSummary,
                    allCitationRows,
                    retrievalStatus,
                    usage,
                    normalizedReasoningMode,
                    Boolean.TRUE.equals(enableWebSearch)
            );
            if (!looksWikiWriteIntent(limitedMessage)) {
                maybeUpdateLongTermMemory(config, userId, limitedMessage, finalReply);
            }
            aiWorkspaceService.completeStep(finalWriterStep, "最终回答已生成", "contentLength=" + finalReply.length());
            emitAgentStepDone(emitter, requestId, agentRun, finalWriterStep);
            completeTask(emitter, requestId, agentRun, finalWriterTask, Map.of("contentLength", finalReply.length()), "Final answer generated");
            Map<String, Object> suggestedPlan = suggestPlanFromChatIfNeeded(config, limitedMessage, finalReply);
            if (plannerStep != null) {
                Map<String, Object> planArtifactContent = new LinkedHashMap<>();
                planArtifactContent.put("tasks", suggestedPlan.get("tasks"));
                planArtifactContent.put("routines", suggestedPlan.get("routines"));
                if (hasPlanDraft(planArtifactContent)) {
                    AiAgentArtifact artifact = aiWorkspaceService.createArtifact(
                            agentRun.getId(),
                            plannerStep.getId(),
                            "PLAN_DRAFT",
                            "AI 计划草稿",
                            planArtifactContent,
                            userMessage.getId()
                    );
                    emitSse(emitter, "artifact.created", artifactEvent(requestId, agentRun, plannerStep, artifact));
                    AiAgentClaim claim = agentBlackboardService.createClaim(
                            agentRun.getId(),
                            plannerStep.getId(),
                            plannerTask == null ? null : plannerTask.getId(),
                            "PLAN_DRAFT",
                            "A structured plan draft was generated for user confirmation.",
                            BigDecimal.valueOf(0.7),
                            evidenceIds,
                            Map.of("artifactId", artifact.getId())
                    );
                    emitSse(emitter, "claim.created", claimEvent(requestId, agentRun, claim));
                }
                aiWorkspaceService.completeStep(plannerStep, "计划草稿已整理", "planDraft=" + hasPlanDraft(planArtifactContent));
                emitAgentStepDone(emitter, requestId, agentRun, plannerStep);
                completeTask(emitter, requestId, agentRun, plannerTask, Map.of("planDraft", hasPlanDraft(planArtifactContent)), "Plan draft ready");
            }
            if (taskDrafterTask != null && hasPlanDraft(suggestedPlan)) {
                startTask(emitter, requestId, agentRun, taskDrafterTask);
                AiAgentStep taskDrafterStep = startAgentStep(emitter, requestId, agentRun, taskDrafterTask, "TASK_DRAFTER", 31, "正在拆分任务草稿");
                if (hasNonEmptyList(suggestedPlan.get("tasks"))) {
                    AiAgentArtifact taskArtifact = aiWorkspaceService.createArtifact(
                            agentRun.getId(),
                            taskDrafterStep.getId(),
                            "TASK_DRAFT",
                            "AI 任务草稿",
                            Map.of("tasks", suggestedPlan.get("tasks")),
                            userMessage.getId()
                    );
                    emitSse(emitter, "artifact.created", artifactEvent(requestId, agentRun, taskDrafterStep, taskArtifact));
                }
                if (hasNonEmptyList(suggestedPlan.get("routines"))) {
                    AiAgentArtifact routineArtifact = aiWorkspaceService.createArtifact(
                            agentRun.getId(),
                            taskDrafterStep.getId(),
                            "ROUTINE_DRAFT",
                            "AI 例行计划草稿",
                            Map.of("routines", suggestedPlan.get("routines")),
                            userMessage.getId()
                    );
                    emitSse(emitter, "artifact.created", artifactEvent(requestId, agentRun, taskDrafterStep, routineArtifact));
                }
                aiWorkspaceService.completeStep(taskDrafterStep, "任务草稿已拆分", "tasks="
                        + (suggestedPlan.get("tasks") instanceof List<?> tasks ? tasks.size() : 0)
                        + ", routines="
                        + (suggestedPlan.get("routines") instanceof List<?> routines ? routines.size() : 0));
                emitAgentStepDone(emitter, requestId, agentRun, taskDrafterStep);
                completeTask(emitter, requestId, agentRun, taskDrafterTask, Map.of(
                        "tasks", suggestedPlan.get("tasks"),
                        "routines", suggestedPlan.get("routines")
                ), "Task drafts ready");
            }
            if (looksWikiWriteIntent(limitedMessage)) {
                Map<String, Object> wikiArtifactContent = new LinkedHashMap<>();
                wikiArtifactContent.put("title", inferWikiDraftTitle(limitedMessage, finalReply));
                wikiArtifactContent.put("content", finalReply);
                AiAgentStep wikiStep = plannerStep != null ? plannerStep : finalWriterStep;
                if (wikiTask != null && !"DONE".equals(wikiTask.getStatus())) {
                    startTask(emitter, requestId, agentRun, wikiTask);
                }
                AiAgentArtifact artifact = aiWorkspaceService.createArtifact(
                        agentRun.getId(),
                        wikiStep == null ? null : wikiStep.getId(),
                        "WIKI_DRAFT",
                        stringValue(wikiArtifactContent.get("title")),
                        wikiArtifactContent,
                        userMessage.getId()
                );
                emitSse(emitter, "artifact.created", artifactEvent(requestId, agentRun, wikiStep, artifact));
                completeTask(emitter, requestId, agentRun, wikiTask, Map.of("artifactId", artifact.getId()), "Wiki draft ready");
            }
            aiWorkspaceService.completeRun(agentRun, assistantMessage);
            Map<String, Object> done = new LinkedHashMap<>();
            done.put("requestId", requestId);
            done.put("agentRunId", agentRun.getId());
            done.put("status", "DONE");
            done.put("userMessageId", userMessage.getId());
            done.put("assistantMessageId", assistantMessage.getId());
            done.put("citations", allCitationRows);
            done.put("retrievalStatus", retrievalStatus);
            done.put("usage", usage);
            done.put("suggestedTasks", suggestedPlan.get("tasks"));
            done.put("suggestedRoutines", suggestedPlan.get("routines"));
            if (hasText(finalReasoningSummary)) {
                done.put("reasoningSummary", finalReasoningSummary);
            }
            emitSse(emitter, "done", done);
        } catch (Exception e) {
            if (dispatcherStep != null && "RUNNING".equals(dispatcherStep.getStatus())) {
                aiWorkspaceService.errorStep(dispatcherStep, e);
            }
            if (retrieverStep != null && "RUNNING".equals(retrieverStep.getStatus())) {
                aiWorkspaceService.errorStep(retrieverStep, e);
            }
            if (plannerStep != null && "RUNNING".equals(plannerStep.getStatus())) {
                aiWorkspaceService.errorStep(plannerStep, e);
            }
            if (finalWriterStep != null && "RUNNING".equals(finalWriterStep.getStatus())) {
                aiWorkspaceService.errorStep(finalWriterStep, e);
            }
            errorRunningTasks(emitter, requestId, agentRun, taskGraph, e);
            aiWorkspaceService.errorRun(agentRun, e);
            failAssistantMessage(assistantMessage, e);
            Map<String, Object> error = new LinkedHashMap<>();
            error.put("requestId", requestId);
            error.put("agentRunId", agentRun.getId());
            error.put("userMessageId", userMessage.getId());
            error.put("assistantMessageId", assistantMessage.getId());
            error.put("message", e.getMessage() == null ? "AI 流式调用失败" : e.getMessage());
            error.put("nonRetryable", e instanceof BusinessException);
            emitSse(emitter, "error", error);
        }
    }

    private void emitSse(SseEmitter emitter, String eventName, Object data) {
        try {
            logStreamEvent(eventName, data);
            emitter.send(SseEmitter.event().name(eventName).data(data));
        } catch (Exception ignored) {
            // The browser may have closed the stream; the async task will finish naturally.
        }
    }

    private void logStreamEvent(String eventName, Object data) {
        if (!streamDebug || !log.isInfoEnabled()) {
            return;
        }
        Object requestId = "";
        Object assistantMessageId = "";
        if (data instanceof Map<?, ?> map) {
            requestId = map.get("requestId") == null ? "" : map.get("requestId");
            assistantMessageId = map.get("assistantMessageId") == null ? "" : map.get("assistantMessageId");
        }
        log.info("AI stream event event={} requestId={} assistantMessageId={}", eventName, requestId, assistantMessageId);
    }

    private String normalizeAgentMode(String agentMode) {
        String value = agentMode == null ? "AUTO" : agentMode.trim().toUpperCase(Locale.ROOT);
        return Set.of("AUTO", "CHAT_ONLY", "RESEARCH", "PLAN").contains(value) ? value : "AUTO";
    }

    private boolean shouldRunRetriever(String agentMode, Boolean enableWebSearch, Long notebookId, Map<String, Object> contextOptions) {
        if ("CHAT_ONLY".equals(agentMode)) {
            return false;
        }
        if ("RESEARCH".equals(agentMode)) {
            return true;
        }
        if (Boolean.TRUE.equals(enableWebSearch) || notebookId != null) {
            return true;
        }
        if (contextOptions == null) {
            return false;
        }
        return Boolean.TRUE.equals(contextOptions.get("includeWiki"))
                || hasNonEmptyList(contextOptions.get("selectedSourceIds"))
                || hasNonEmptyList(contextOptions.get("selectedWikiPageIds"));
    }

    private boolean shouldRunPlanner(String agentMode, String message) {
        if ("PLAN".equals(agentMode)) {
            return true;
        }
        if ("CHAT_ONLY".equals(agentMode) || "RESEARCH".equals(agentMode)) {
            return false;
        }
        String text = message == null ? "" : message;
        return text.contains("计划") || text.contains("任务") || text.contains("例行") || text.toLowerCase(Locale.ROOT).contains("plan");
    }

    private boolean hasNonEmptyList(Object value) {
        return value instanceof List<?> list && !list.isEmpty();
    }

    private AiAgentStep startAgentStep(SseEmitter emitter, String requestId, AiAgentRun run,
                                       String agentType, int order, String publicSummary) {
        return startAgentStep(emitter, requestId, run, null, agentType, order, publicSummary);
    }

    private AiAgentStep startAgentStep(SseEmitter emitter, String requestId, AiAgentRun run,
                                       AiAgentTask task, String agentType, int order, String publicSummary) {
        AiAgentStep step = aiWorkspaceService.startStep(run.getId(), task == null ? null : task.getId(), agentType, order, publicSummary);
        emitSse(emitter, "agent.step.start", Map.of(
                "requestId", requestId,
                "runId", run.getId(),
                "agentRunId", run.getId(),
                "taskId", task == null ? null : task.getId(),
                "stepId", step.getId(),
                "agentType", agentType,
                "stepOrder", order,
                "status", step.getStatus(),
                "publicSummary", publicSummary
        ));
        return step;
    }

    private void emitAgentTaskCreated(SseEmitter emitter, String requestId, AiAgentRun run, AiAgentTask task) {
        if (task == null) {
            return;
        }
        emitSse(emitter, "agent.task.created", taskEvent(requestId, run, task));
    }

    private void startTask(SseEmitter emitter, String requestId, AiAgentRun run, AiAgentTask task) {
        if (task == null || "RUNNING".equals(task.getStatus()) || "DONE".equals(task.getStatus())) {
            return;
        }
        agentTaskGraphService.startTask(task);
        emitSse(emitter, "agent.task.start", taskEvent(requestId, run, task));
    }

    private void completeTask(SseEmitter emitter, String requestId, AiAgentRun run,
                              AiAgentTask task, Map<String, Object> output, String publicSummary) {
        if (task == null || "DONE".equals(task.getStatus()) || "SKIPPED".equals(task.getStatus())) {
            return;
        }
        agentTaskGraphService.completeTask(task, output, publicSummary);
        emitSse(emitter, "agent.task.done", taskEvent(requestId, run, task));
    }

    private void skipTask(SseEmitter emitter, String requestId, AiAgentRun run, AiAgentTask task, String publicSummary) {
        if (task == null || "DONE".equals(task.getStatus()) || "SKIPPED".equals(task.getStatus())) {
            return;
        }
        agentTaskGraphService.skipTask(task, publicSummary);
        emitSse(emitter, "agent.task.done", taskEvent(requestId, run, task));
    }

    private void errorRunningTasks(SseEmitter emitter, String requestId, AiAgentRun run,
                                   List<AiAgentTask> tasks, Exception error) {
        if (tasks == null) {
            return;
        }
        for (AiAgentTask task : tasks) {
            if (task != null && "RUNNING".equals(task.getStatus())) {
                agentTaskGraphService.errorTask(task, error);
                emitSse(emitter, "agent.task.error", taskEvent(requestId, run, task));
            }
        }
    }

    private void startResearchTasks(SseEmitter emitter, String requestId, AiAgentRun run, List<AiAgentTask> tasks) {
        for (AiAgentTask task : researchTasks(tasks)) {
            startTask(emitter, requestId, run, task);
        }
    }

    private void completeResearchTasks(SseEmitter emitter, String requestId, AiAgentRun run,
                                       List<AiAgentTask> tasks, Map<String, Object> output) {
        for (AiAgentTask task : researchTasks(tasks)) {
            completeTask(emitter, requestId, run, task, output, "Research complete");
        }
    }

    private void skipResearchTasks(SseEmitter emitter, String requestId, AiAgentRun run, List<AiAgentTask> tasks) {
        for (AiAgentTask task : researchTasks(tasks)) {
            skipTask(emitter, requestId, run, task, "Research skipped");
        }
    }

    private List<AiAgentTask> researchTasks(List<AiAgentTask> tasks) {
        if (tasks == null) {
            return List.of();
        }
        return tasks.stream()
                .filter(task -> task != null && Set.of("NOTEBOOK_RESEARCHER", "WIKI_RESEARCHER", "WEB_RESEARCHER", "RETRIEVER")
                        .contains(task.getAgentType()))
                .toList();
    }

    private Map<String, AiAgentTask> taskMap(List<AiAgentTask> tasks) {
        Map<String, AiAgentTask> result = new LinkedHashMap<>();
        if (tasks == null) {
            return result;
        }
        for (AiAgentTask task : tasks) {
            result.putIfAbsent(task.getAgentType(), task);
        }
        return result;
    }

    private AiAgentTask firstTask(Map<String, AiAgentTask> tasks, String... agentTypes) {
        if (tasks == null) {
            return null;
        }
        for (String agentType : agentTypes) {
            AiAgentTask task = tasks.get(agentType);
            if (task != null) {
                return task;
            }
        }
        return null;
    }

    private Map<String, Object> taskEvent(String requestId, AiAgentRun run, AiAgentTask task) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("requestId", requestId);
        event.put("runId", run.getId());
        event.put("agentRunId", run.getId());
        event.put("taskId", task.getId());
        event.put("agentType", task.getAgentType());
        event.put("taskType", task.getTaskType());
        event.put("status", task.getStatus());
        event.put("dependsOn", parseJsonList(task.getDependsOnJson()));
        event.put("parallelGroupId", task.getParallelGroupId());
        event.put("publicSummary", task.getPublicSummary() == null ? "" : task.getPublicSummary());
        return event;
    }

    private void emitAgentStepDone(SseEmitter emitter, String requestId, AiAgentRun run, AiAgentStep step) {
        if (step == null) {
            return;
        }
        emitSse(emitter, "agent.step.done", Map.of(
                "requestId", requestId,
                "runId", run.getId(),
                "agentRunId", run.getId(),
                "stepId", step.getId(),
                "agentType", step.getAgentType(),
                "stepOrder", step.getStepOrder(),
                "status", step.getStatus(),
                "publicSummary", step.getPublicSummary() == null ? "" : step.getPublicSummary()
        ));
    }

    private void emitAgentStepSkipped(SseEmitter emitter, String requestId, AiAgentRun run,
                                      String agentType, int order, String publicSummary) {
        emitSse(emitter, "agent.step.done", Map.of(
                "requestId", requestId,
                "runId", run.getId(),
                "agentRunId", run.getId(),
                "agentType", agentType,
                "stepOrder", order,
                "status", "SKIPPED",
                "publicSummary", publicSummary
        ));
    }

    private Map<String, Object> artifactEvent(String requestId, AiAgentRun run, AiAgentStep step, AiAgentArtifact artifact) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("requestId", requestId);
        event.put("runId", run.getId());
        event.put("agentRunId", run.getId());
        event.put("stepId", step == null ? null : step.getId());
        event.put("artifactId", artifact.getId());
        event.put("artifactType", artifact.getArtifactType());
        event.put("title", artifact.getTitle());
        event.put("status", artifact.getStatus());
        return event;
    }

    private Map<String, Object> evidenceEvent(String requestId, AiAgentRun run, AiAgentEvidence evidence) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("requestId", requestId);
        event.put("runId", run.getId());
        event.put("agentRunId", run.getId());
        event.put("evidenceId", evidence.getId());
        event.put("taskId", evidence.getTaskId());
        event.put("stepId", evidence.getStepId());
        event.put("sourceType", evidence.getSourceType());
        event.put("sourceId", evidence.getSourceId());
        event.put("artifactId", evidence.getArtifactId());
        event.put("snippet", evidence.getSnippet() == null ? "" : evidence.getSnippet());
        return event;
    }

    private Map<String, Object> claimEvent(String requestId, AiAgentRun run, AiAgentClaim claim) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("requestId", requestId);
        event.put("runId", run.getId());
        event.put("agentRunId", run.getId());
        event.put("claimId", claim.getId());
        event.put("taskId", claim.getTaskId());
        event.put("stepId", claim.getStepId());
        event.put("claimType", claim.getClaimType());
        event.put("content", claim.getContent());
        event.put("confidence", claim.getConfidence());
        event.put("evidenceIds", parseJsonList(claim.getEvidenceIdsJson()));
        return event;
    }

    private Map<String, Object> findingEvent(String requestId, AiAgentRun run, AiVerifierFinding finding) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("requestId", requestId);
        event.put("runId", run.getId());
        event.put("agentRunId", run.getId());
        event.put("findingId", finding.getId());
        event.put("taskId", finding.getTaskId());
        event.put("severity", finding.getSeverity());
        event.put("code", finding.getCode());
        event.put("message", finding.getMessage());
        event.put("targetType", finding.getTargetType());
        event.put("targetId", finding.getTargetId());
        event.put("action", finding.getAction());
        return event;
    }

    private List<Object> parseJsonList(String json) {
        if (json == null || json.isBlank()) {
            return List.of();
        }
        try {
            return objectMapper.readValue(json, List.class);
        } catch (Exception e) {
            return List.of();
        }
    }

    private boolean isSuccessfulCitation(Map<String, Object> citation) {
        String status = String.valueOf(citation == null ? "" : citation.getOrDefault("status", ""));
        return status.isBlank() || "OK".equalsIgnoreCase(status) || "SUCCESS".equalsIgnoreCase(status);
    }

    private String withWebSearchContext(String message, List<WebSearchProvider.SearchResult> citations) {
        citations = citations == null
                ? List.of()
                : citations.stream().filter(this::isSuccessfulCitation).toList();
        if (citations == null || citations.isEmpty()) {
            return message;
        }
        StringBuilder builder = new StringBuilder(message);
        builder.append("\n\n联网搜索引用资料（请基于这些资料回答，并在需要时引用来源）：\n");
        for (int i = 0; i < citations.size(); i++) {
            WebSearchProvider.SearchResult item = citations.get(i);
            builder.append(i + 1)
                    .append(". ")
                    .append(item.title())
                    .append("\nURL: ")
                    .append(item.url())
                    .append("\n摘要: ")
                    .append(item.snippet())
                    .append("\n");
        }
        return builder.toString();
    }

    private String withNotebookContext(String message, List<Map<String, Object>> contextRows) {
        if (contextRows == null || contextRows.isEmpty()) {
            return message;
        }
        StringBuilder builder = new StringBuilder(message == null ? "" : message);
        builder.append("\n\nNotebook / Wiki context snippets. Use only when relevant:\n");
        int index = 1;
        for (Map<String, Object> row : contextRows) {
            String title = stringValue(row.get("title"));
            String content = stringValue(row.get("content"));
            if (!hasText(content)) {
                continue;
            }
            builder.append("\n[Context ").append(index++).append("] ")
                    .append(hasText(title) ? title : "Untitled")
                    .append("\n")
                    .append(limitText(content, 1600))
                    .append("\n");
        }
        return builder.toString();
    }

    private boolean hasPlanDraft(Map<String, Object> planArtifactContent) {
        if (planArtifactContent == null) {
            return false;
        }
        Object tasks = planArtifactContent.get("tasks");
        Object routines = planArtifactContent.get("routines");
        return (tasks instanceof List<?> taskList && !taskList.isEmpty())
                || (routines instanceof List<?> routineList && !routineList.isEmpty());
    }

    private boolean isSuccessfulCitation(WebSearchProvider.SearchResult item) {
        String status = item == null || item.status() == null ? "" : item.status().trim().toUpperCase(Locale.ROOT);
        return status.isEmpty() || "OK".equals(status) || "SUCCESS".equals(status);
    }

    private Map<String, Object> retrievalStatus(List<WebSearchProvider.SearchResult> citations) {
        if (citations == null || citations.isEmpty()) {
            return Map.of("successCount", 0, "failedCount", 0, "errors", List.of());
        }
        int successCount = 0;
        List<Map<String, Object>> errors = new ArrayList<>();
        for (WebSearchProvider.SearchResult item : citations) {
            if (isSuccessfulCitation(item)) {
                successCount++;
            } else {
                Map<String, Object> error = new LinkedHashMap<>();
                error.put("source", item.url());
                error.put("title", item.title());
                error.put("status", item.status());
                error.put("reason", item.snippet());
                errors.add(error);
            }
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("successCount", successCount);
        result.put("failedCount", errors.size());
        result.put("errors", errors);
        return result;
    }

    private List<Map<String, Object>> citationRows(List<WebSearchProvider.SearchResult> citations) {
        if (citations == null || citations.isEmpty()) {
            return List.of();
        }
        List<Map<String, Object>> rows = new ArrayList<>();
        for (WebSearchProvider.SearchResult item : citations) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("title", item.title());
            row.put("url", item.url());
            row.put("snippet", item.snippet());
            row.put("sourceType", item.sourceType());
            row.put("status", item.status());
            rows.add(row);
        }
        return rows;
    }

    private String normalizeReasoningMode(String mode) {
        String normalized = hasText(mode) ? mode.trim().toUpperCase(Locale.ROOT) : "OFF";
        return Set.of("AUTO", "DEEP").contains(normalized) ? normalized : "OFF";
    }

    private boolean isReasoningRequested(String mode) {
        return "AUTO".equals(mode) || "DEEP".equals(mode);
    }

    private boolean supportsDeepReasoning(AiModelConfig config) {
        String caps = config == null || config.getCapabilities() == null ? "" : config.getCapabilities().toUpperCase(Locale.ROOT);
        String name = config == null || config.getModelName() == null ? "" : config.getModelName().toLowerCase(Locale.ROOT);
        String provider = config == null ? "" : normalizeProviderType(config.getProviderType());
        return caps.contains("REASONING")
                || caps.contains("THINKING")
                || name.contains("deepseek-reasoner")
                || name.contains("reasoner")
                || name.startsWith("o1")
                || name.startsWith("o3")
                || name.startsWith("o4")
                || name.startsWith("gpt-5")
                || ("ANTHROPIC".equals(provider) && name.contains("claude"));
    }

    private boolean shouldProbeReasoning(AiModelConfig config) {
        if (supportsDeepReasoning(config)) {
            return true;
        }
        String name = config == null || config.getModelName() == null ? "" : config.getModelName().toLowerCase(Locale.ROOT);
        String provider = config == null ? "" : normalizeProviderType(config.getProviderType());
        return "ANTHROPIC".equals(provider)
                || name.contains("think")
                || name.contains("reason")
                || name.contains("deepseek")
                || name.startsWith("o1")
                || name.startsWith("o3")
                || name.startsWith("o4");
    }

    @Override
    public Map<String, Object> listModels(Long userId) {
        ensureLegacyConfigMigrated(userId);
        List<Map<String, Object>> systemModels = new ArrayList<>();
        AiModelConfig systemModel = systemModel();
        if (systemModel != null) {
            systemModels.add(modelRow(systemModel, true));
        }
        List<AiModelConfig> userModels = modelConfigMapper.selectList(new LambdaQueryWrapper<AiModelConfig>()
                .eq(AiModelConfig::getUserId, userId)
                .eq(AiModelConfig::getOwnerType, "USER")
                .orderByDesc(AiModelConfig::getIsDefault)
                .orderByDesc(AiModelConfig::getUpdatedAt));
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("systemModels", systemModels);
        result.put("userModels", userModels.stream().map(model -> modelRow(model, false)).toList());
        AiModelConfig selected = getDefaultUserModel(userId);
        result.put("defaultModelId", selected != null ? selected.getId() : (systemModel != null ? systemModel.getId() : null));
        result.put("webSearchAvailable", webResearchService.isSearchAvailable());
        result.put("webFetchAvailable", true);
        result.put("pushPublicKeyConfigured", false);
        return result;
    }

    @Override
    @Transactional
    public Map<String, Object> saveModel(Long userId, Long id, Map<String, Object> body) {
        AiModelConfig model = null;
        if (id != null) {
            model = modelConfigMapper.selectOne(new LambdaQueryWrapper<AiModelConfig>()
                    .eq(AiModelConfig::getId, id)
                    .eq(AiModelConfig::getUserId, userId)
                    .eq(AiModelConfig::getOwnerType, "USER"));
            if (model == null) {
                throw new BusinessException("模型配置不存在或无权访问");
            }
        }
        boolean creating = model == null;
        if (creating) {
            model = new AiModelConfig();
            model.setUserId(userId);
            model.setOwnerType("USER");
            model.setEnabled(1);
            model.setUsedToday(0);
            model.setIsDefault(0);
        }
        String providerType = normalizeProviderType(valueOr(body.get("providerType"), "OPENAI_COMPATIBLE"));
        String modelName = valueOr(body.get("modelName"), creating ? "" : model.getModelName());
        String apiKey = stringValue(body.get("apiKey"));
        if (creating && !hasText(apiKey) && !"OLLAMA".equals(providerType)) {
            throw new BusinessException("请填写 API Key");
        }
        String normalizedApiUrl = normalizeProviderApiUrl(valueOr(body.get("apiUrl"), defaultApiUrl(providerType)), providerType);
        validateProviderRequestUrl(normalizedApiUrl);
        model.setProviderType(providerType);
        model.setDisplayName(cleanModelDisplayName(valueOr(body.get("displayName"), modelName)));
        model.setApiUrl(normalizedApiUrl);
        model.setModelName(hasText(modelName) ? modelName.trim() : defaultModelName(providerType));
        model.setCapabilities(normalizeCapabilities(valueOr(body.get("capabilities"), "TEXT")));
        model.setEnabled(booleanValue(body.get("enabled"), true) ? 1 : 0);
        if (body.containsKey("dailyQuota")) {
            model.setDailyQuota(parseInteger(body.get("dailyQuota")));
        }
        if (hasText(apiKey) && !apiKey.endsWith("****")) {
            model.setEncryptedApiKey(cryptoService.encrypt(apiKey.trim()));
            model.setEncryptionVersion("v1");
        }
        if (creating) {
            modelConfigMapper.insert(model);
        } else {
            modelConfigMapper.updateById(model);
        }
        if (booleanValue(body.get("isDefault"), creating)) {
            setDefaultUserModel(userId, model.getId());
        }
        return modelRow(modelConfigMapper.selectById(model.getId()), false);
    }

    @Override
    @Transactional
    public void deleteModel(Long userId, Long id) {
        AiModelConfig model = modelConfigMapper.selectOne(new LambdaQueryWrapper<AiModelConfig>()
                .eq(AiModelConfig::getId, id)
                .eq(AiModelConfig::getUserId, userId)
                .eq(AiModelConfig::getOwnerType, "USER"));
        if (model == null) {
            throw new BusinessException("模型配置不存在或无权访问");
        }
        modelConfigMapper.deleteById(model.getId());
    }

    @Override
    public Map<String, Object> testModel(Long userId, Long id) {
        AiModelConfig model = requireModel(userId, id);
        String reply = callAiApi(model, "你是连通性测试助手。", "请只回复 OK");
        return Map.of("ok", true, "reply", limitText(reply, 80));
    }

    @Override
    @Transactional
    public Map<String, Object> probeModel(Long userId, Long id) {
        AiModelConfig model = requireModel(userId, id);
        Map<String, Object> result = new LinkedHashMap<>();

        boolean connectivityOk = false;
        boolean visionOk = false;
        boolean reasoningOk = false;
        String connectivityMessage = "";
        String visionMessage = "";
        String reasoningMessage = "";

        try {
            String reply = callAiApi(model, "You are a connectivity probe. Reply with OK only.", "Reply with OK.");
            connectivityOk = hasText(reply);
            connectivityMessage = limitText(reply, 120);
        } catch (Exception e) {
            connectivityMessage = limitText(e.getMessage(), 240);
        }

        if (connectivityOk) {
            try {
                List<Map<String, Object>> userContent = List.of(
                        Map.of("type", "text", "text", "This is a tiny capability probe image. Reply with OK if you can inspect images."),
                        Map.of("type", "image_url", "image_url", Map.of("url", "data:image/png;base64," + PROBE_IMAGE_BASE64))
                );
                String reply = callAiApiWithVision(model, "You are a vision capability probe. Reply with OK only.", userContent);
                visionOk = hasText(reply);
                visionMessage = limitText(reply, 120);
            } catch (Exception e) {
                visionMessage = limitText(e.getMessage(), 240);
            }
        } else {
            visionMessage = "Skipped because connectivity failed.";
        }

        if (connectivityOk && shouldProbeReasoning(model)) {
            try {
                AiCallResult reply = callAiApiDetailed(model, List.of(
                        Map.of("role", "system", "content", "You are a reasoning capability probe. Keep the final answer short."),
                        Map.of("role", "user", "content", "What is 17 + 25? Reply with the answer only.")
                ), "AUTO");
                reasoningOk = hasText(reply.reasoningSummary());
                reasoningMessage = reasoningOk ? limitText(reply.reasoningSummary(), 160)
                        : "Model responded, but no separate reasoning stream/content was detected.";
            } catch (Exception e) {
                reasoningMessage = limitText(e.getMessage(), 240);
            }
        } else {
            reasoningMessage = connectivityOk ? "Skipped because the model does not look like a reasoning model."
                    : "Skipped because connectivity failed.";
        }

        Set<String> capabilities = new LinkedHashSet<>();
        capabilities.add("TEXT");
        if (visionOk) {
            capabilities.add("VISION");
        }
        if (reasoningOk) {
            capabilities.add("REASONING");
        }
        model.setCapabilities(String.join(",", capabilities));
        model.setCapabilityProbeStatus(connectivityOk ? "VERIFIED" : "FAILED");
        model.setVisionStatus(visionOk ? "VERIFIED" : (connectivityOk ? "UNSUPPORTED" : "UNTESTED"));
        model.setReasoningStatus(reasoningOk ? "VERIFIED" : (connectivityOk ? "UNSUPPORTED" : "UNTESTED"));
        model.setLastProbeAt(LocalDateTime.now());
        modelConfigMapper.updateById(model);

        result.put("ok", connectivityOk);
        result.put("capabilityProbeStatus", model.getCapabilityProbeStatus());
        result.put("visionStatus", model.getVisionStatus());
        result.put("reasoningStatus", model.getReasoningStatus());
        result.put("lastProbeAt", model.getLastProbeAt());
        result.put("connectivityMessage", connectivityMessage);
        result.put("visionMessage", visionMessage);
        result.put("reasoningMessage", reasoningMessage);
        result.put("model", modelRow(modelConfigMapper.selectById(model.getId()), false));
        return result;
    }

    @Override
    public Map<String, Object> getMemory(Long userId) {
        UserAiMemory memory = getMemoryEntity(userId);
        AiConversation conversation = getDefaultConversation(userId);
        long messageCount = 0;
        List<Map<String, Object>> recentMessages = new ArrayList<>();
        if (conversation != null) {
            messageCount = messageMapper.selectCount(
                    new LambdaQueryWrapper<AiMessage>()
                            .eq(AiMessage::getUserId, userId)
                            .eq(AiMessage::getConversationId, conversation.getId())
            );
            for (AiMessage item : getRecentMessages(userId, conversation.getId(), 10)) {
                Map<String, Object> row = new HashMap<>();
                row.put("id", item.getId());
                row.put("role", item.getRole());
                row.put("content", item.getContent());
                row.put("agentRunId", item.getAgentRunId());
                row.put("status", normalizeMessageStatus(item.getStatus()));
                row.put("requestId", item.getRequestId());
                row.put("providerType", item.getProviderType());
                row.put("modelName", item.getModelName());
                row.put("reasoningSummary", item.getReasoningSummary());
                row.put("citations", parseCitationsJson(item.getCitationsJson()));
                row.put("retrievalStatus", parseJsonObjectMap(item.getRetrievalStatusJson()));
                row.put("usage", parseJsonObjectMap(item.getUsageJson()));
                row.put("reasoningMode", item.getReasoningMode());
                row.put("webSearchEnabled", Boolean.TRUE.equals(item.getWebSearchEnabled()));
                row.put("errorMessage", item.getErrorMessage());
                row.put("createdAt", item.getCreatedAt());
                row.put("completedAt", item.getCompletedAt());
                recentMessages.add(row);
            }
        }
        Map<String, Object> result = new HashMap<>();
        result.put("memoryText", decryptMemory(memory));
        result.put("messageCount", messageCount);
        result.put("recentMessages", recentMessages);
        return result;
    }

    @Override
    public List<Map<String, Object>> getRecentChatMessages(Long userId, int limit) {
        AiConversation conversation = getDefaultConversation(userId);
        if (conversation == null) {
            return List.of();
        }
        List<Map<String, Object>> result = new ArrayList<>();
        for (AiMessage item : getRecentMessages(userId, conversation.getId(), Math.min(Math.max(limit, 1), 100))) {
            if (!isChatRole(item.getRole())) {
                continue;
            }
            Map<String, Object> row = new HashMap<>();
            row.put("id", item.getId());
            row.put("role", item.getRole());
            row.put("content", item.getContent());
            row.put("agentRunId", item.getAgentRunId());
            row.put("status", normalizeMessageStatus(item.getStatus()));
            row.put("requestId", item.getRequestId());
            row.put("providerType", item.getProviderType());
            row.put("modelName", item.getModelName());
            row.put("reasoningSummary", item.getReasoningSummary());
            row.put("citations", parseCitationsJson(item.getCitationsJson()));
            row.put("retrievalStatus", parseJsonObjectMap(item.getRetrievalStatusJson()));
            row.put("usage", parseJsonObjectMap(item.getUsageJson()));
            row.put("reasoningMode", item.getReasoningMode());
            row.put("webSearchEnabled", Boolean.TRUE.equals(item.getWebSearchEnabled()));
            row.put("errorMessage", item.getErrorMessage());
            row.put("createdAt", item.getCreatedAt());
            row.put("completedAt", item.getCompletedAt());
            result.add(row);
        }
        return result;
    }

    @Override
    public void saveMemory(Long userId, String memoryText) {
        upsertMemory(userId, limitText(memoryText, MEMORY_MAX_LENGTH));
    }

    @Override
    public void clearMemory(Long userId) {
        UserAiMemory memory = getMemoryEntity(userId);
        if (memory != null) {
            memoryMapper.deleteById(memory.getId());
        }
        AiConversation conversation = getDefaultConversation(userId);
        if (conversation != null) {
            List<AiMessage> messages = messageMapper.selectList(
                    new LambdaQueryWrapper<AiMessage>()
                            .eq(AiMessage::getUserId, userId)
                            .eq(AiMessage::getConversationId, conversation.getId())
            );
            for (AiMessage message : messages) {
                messageMapper.deleteById(message.getId());
            }
            conversationMapper.deleteById(conversation.getId());
        }
    }

    @Override
    public void deleteChatMessage(Long userId, Long messageId) {
        if (messageId == null) {
            throw new BusinessException("消息不存在");
        }
        AiMessage message = messageMapper.selectOne(
                new LambdaQueryWrapper<AiMessage>()
                        .eq(AiMessage::getId, messageId)
                        .eq(AiMessage::getUserId, userId)
        );
        if (message == null) {
            throw new BusinessException("消息不存在或无权删除");
        }
        messageMapper.deleteById(message.getId());
    }

    // ── 私有辅助方法 ──────────────────────────────────────

    /** 校验模型配置并返回，未配置时抛出业务异常 */
    private AiModelConfig requireModel(Long userId, Long modelConfigId) {
        ensureLegacyConfigMigrated(userId);
        AiModelConfig model;
        if (modelConfigId != null && modelConfigId == SYSTEM_MODEL_ID) {
            model = systemModel();
        } else if (modelConfigId != null) {
            model = modelConfigMapper.selectOne(new LambdaQueryWrapper<AiModelConfig>()
                    .eq(AiModelConfig::getId, modelConfigId)
                    .and(q -> q.eq(AiModelConfig::getOwnerType, "SYSTEM")
                            .or(w -> w.eq(AiModelConfig::getOwnerType, "USER").eq(AiModelConfig::getUserId, userId))));
        } else {
            model = getDefaultUserModel(userId);
            if (model == null) {
                model = systemModel();
            }
        }
        if (model == null || model.getEnabled() == null || model.getEnabled() != 1) {
            throw new BusinessException("请先在个人中心配置可用的 AI 模型");
        }
        if (!"OLLAMA".equals(normalizeProviderType(model.getProviderType()))
                && !hasText(decryptedApiKey(model))) {
            throw new BusinessException("当前模型缺少 API Key，请在个人中心补充");
        }
        return model;
    }

    private String buildChatSystemPrompt(String memoryText) {
        String today = LocalDate.now(ZoneId.of("Asia/Shanghai")).toString();
        String memoryBlock = hasText(memoryText) ? memoryText : "暂无长期记忆。";
        return """
                你是「知趣·象限学习系统」的 AI 助手，帮助大学生做学习规划、DDL 拆解、复习节奏和时间管理。
                今天是 %s，时区是 Asia/Shanghai。

                你拥有两类上下文：
                1. 长期记忆：用户明确保存或系统从长期偏好中整理出的信息。
                2. 最近对话：系统会附带最近若干轮聊天。

                长期记忆：
                %s

                使用规则：
                - 可以自然利用长期记忆和最近对话，但不要编造未出现的信息。
                - 用户偏好不列特别具体计划时，优先给轻量、可执行、可商榷的安排。
                - 涉及任务、DDL、考研计划时，尽量给出可落地的下一步。
                - 默认使用 GitHub Flavored Markdown 排版，回答简洁友好。
                - 标题必须写成 `## 标题`、`### 标题`，井号后必须有一个空格。
                - 如果使用表格，必须输出标准 GFM 表格：
                  1. 必须有表头行和 `| --- | --- |` 分隔行。
                  2. 每一行必须以 `|` 开头并以 `|` 结尾。
                  3. 每一条数据行都单独占一行，且列数必须和表头一致。
                  4. 禁止使用制表符、空格对齐表格、半截管道行或把单元格内容换到下一行。
                  5. 单元格里需要多项内容时，用顿号、分号或 `<br>`，不要直接换行。
                """.formatted(today, memoryBlock);
    }

    private AiConversation getDefaultConversation(Long userId) {
        return conversationMapper.selectOne(
                new LambdaQueryWrapper<AiConversation>()
                        .eq(AiConversation::getUserId, userId)
                        .eq(AiConversation::getConversationKey, DEFAULT_CONVERSATION_KEY)
        );
    }

    private AiConversation getOrCreateDefaultConversation(Long userId) {
        AiConversation conversation = getDefaultConversation(userId);
        if (conversation != null) {
            return conversation;
        }
        conversation = new AiConversation();
        conversation.setUserId(userId);
        conversation.setConversationKey(DEFAULT_CONVERSATION_KEY);
        conversation.setTitle("默认对话");
        conversationMapper.insert(conversation);
        return conversation;
    }

    private List<AiMessage> getRecentMessages(Long userId, Long conversationId, int limit) {
        List<AiMessage> messages = messageMapper.selectList(
                new LambdaQueryWrapper<AiMessage>()
                        .eq(AiMessage::getUserId, userId)
                        .eq(AiMessage::getConversationId, conversationId)
                        .orderByDesc(AiMessage::getId)
                        .last("LIMIT " + Math.max(1, limit))
        );
        Collections.reverse(messages);
        return messages;
    }

    private AiMessage saveChatMessage(Long userId, Long conversationId, String role, String content) {
        return saveChatMessage(userId, conversationId, role, content, null, null, null, false);
    }

    private AiMessage saveChatMessage(Long userId, Long conversationId, String role, String content,
                                      String reasoningSummary, List<Map<String, Object>> citations,
                                      String reasoningMode, boolean webSearchEnabled) {
        return saveChatMessage(userId, conversationId, role, content, reasoningSummary, citations,
                null, null, reasoningMode, webSearchEnabled);
    }

    private AiMessage saveChatMessage(Long userId, Long conversationId, String role, String content,
                                      String reasoningSummary, List<Map<String, Object>> citations,
                                      Map<String, Object> retrievalStatus, Map<String, Object> usage,
                                      String reasoningMode, boolean webSearchEnabled) {
        AiMessage message = new AiMessage();
        message.setUserId(userId);
        message.setConversationId(conversationId);
        message.setRole(role);
        message.setContent(content);
        message.setStatus("DONE");
        message.setReasoningSummary(hasText(reasoningSummary) ? limitText(reasoningSummary, 2000) : null);
        message.setCitationsJson(toJson(citations == null ? List.of() : citations));
        message.setRetrievalStatusJson(toJson(retrievalStatus == null ? Map.of() : retrievalStatus));
        message.setUsageJson(toJson(usage == null ? Map.of() : usage));
        message.setReasoningMode(hasText(reasoningMode) ? reasoningMode : "OFF");
        message.setWebSearchEnabled(webSearchEnabled);
        message.setCompletedAt(LocalDateTime.now());
        messageMapper.insert(message);
        return message;
    }

    private AiMessage createStreamingAssistantMessage(Long userId, Long conversationId, String requestId,
                                                      AiModelConfig config, String reasoningMode,
                                                      boolean webSearchEnabled) {
        AiMessage message = new AiMessage();
        message.setUserId(userId);
        message.setConversationId(conversationId);
        message.setRole("assistant");
        message.setContent("");
        message.setStatus("STREAMING");
        message.setRequestId(requestId);
        message.setProviderType(config.getProviderType());
        message.setModelName(config.getModelName());
        message.setReasoningSummary(null);
        message.setCitationsJson(toJson(List.of()));
        message.setRetrievalStatusJson(toJson(Map.of()));
        message.setUsageJson(toJson(Map.of()));
        message.setReasoningMode(hasText(reasoningMode) ? reasoningMode : "OFF");
        message.setWebSearchEnabled(webSearchEnabled);
        messageMapper.insert(message);
        return message;
    }

    private void completeAssistantMessage(AiMessage message, String content, String reasoningSummary,
                                          List<Map<String, Object>> citations,
                                          Map<String, Object> retrievalStatus,
                                          Map<String, Object> usage,
                                          String reasoningMode,
                                          boolean webSearchEnabled) {
        message.setContent(content == null ? "" : content);
        message.setStatus("DONE");
        message.setReasoningSummary(hasText(reasoningSummary) ? limitText(reasoningSummary, 2000) : null);
        message.setCitationsJson(toJson(citations == null ? List.of() : citations));
        message.setRetrievalStatusJson(toJson(retrievalStatus == null ? Map.of() : retrievalStatus));
        message.setUsageJson(toJson(usage == null ? Map.of() : usage));
        message.setReasoningMode(hasText(reasoningMode) ? reasoningMode : "OFF");
        message.setWebSearchEnabled(webSearchEnabled);
        message.setCompletedAt(LocalDateTime.now());
        message.setErrorMessage(null);
        messageMapper.updateById(message);
    }

    private void failAssistantMessage(AiMessage message, Exception e) {
        if (message == null || message.getId() == null) {
            return;
        }
        message.setStatus("ERROR");
        message.setCompletedAt(LocalDateTime.now());
        message.setErrorMessage(limitText(e == null || e.getMessage() == null ? "AI 流式调用失败" : e.getMessage(), 500));
        messageMapper.updateById(message);
    }

    private Map<String, Object> withStreamMeta(Map<String, Object> row, String requestId, Long assistantMessageId) {
        Map<String, Object> result = new LinkedHashMap<>();
        if (row != null) {
            result.putAll(row);
        }
        result.put("requestId", requestId);
        result.put("assistantMessageId", assistantMessageId);
        return result;
    }

    private String toJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (Exception e) {
            return "[]";
        }
    }

    private List<?> parseCitationsJson(String citationsJson) {
        if (!hasText(citationsJson)) {
            return List.of();
        }
        try {
            Object value = objectMapper.readValue(citationsJson, List.class);
            if (value instanceof List<?> list) {
                return list;
            }
        } catch (Exception ignored) {
            // Old rows may not have structured citation metadata.
        }
        return List.of();
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> parseJsonObjectMap(String json) {
        if (!hasText(json)) {
            return Map.of();
        }
        try {
            Object value = objectMapper.readValue(json, Map.class);
            if (value instanceof Map<?, ?> map) {
                Map<String, Object> result = new LinkedHashMap<>();
                map.forEach((key, rowValue) -> result.put(String.valueOf(key), rowValue));
                return result;
            }
        } catch (Exception ignored) {
            // Old rows may not have structured metadata.
        }
        return Map.of();
    }

    private boolean isChatRole(String role) {
        String normalized = normalizeChatRole(role);
        return "user".equals(normalized) || "assistant".equals(normalized);
    }

    private String normalizeChatRole(String role) {
        String value = role == null ? "" : role.trim().toLowerCase(Locale.ROOT);
        if ("ai".equals(value) || "model".equals(value)) {
            return "assistant";
        }
        return value;
    }

    private String normalizeMessageStatus(String status) {
        String value = hasText(status) ? status.trim().toUpperCase(Locale.ROOT) : "DONE";
        return Set.of("STREAMING", "DONE", "ERROR", "ABORTED").contains(value) ? value : "DONE";
    }

    private UserAiMemory getMemoryEntity(Long userId) {
        return memoryMapper.selectOne(
                new LambdaQueryWrapper<UserAiMemory>().eq(UserAiMemory::getUserId, userId)
        );
    }

    private String getMemoryText(Long userId) {
        return getMemoryText(userId, "");
    }

    private String getMemoryText(Long userId, String queryText) {
        UserAiMemory memory = getMemoryEntity(userId);
        List<String> parts = new ArrayList<>();
        String manual = decryptMemory(memory);
        if (hasText(manual)) {
            parts.add("手动长期记忆：\n" + manual);
        }
        List<UserKnowledgePage> pages = knowledgePageMapper.selectList(new LambdaQueryWrapper<UserKnowledgePage>()
                .eq(UserKnowledgePage::getUserId, userId)
                .orderByDesc(UserKnowledgePage::getPinned)
                .orderByDesc(UserKnowledgePage::getUpdatedAt)
                .last("LIMIT 50"));
        List<UserKnowledgePage> selected = pages.stream()
                .sorted((a, b) -> Integer.compare(knowledgeScore(b, queryText), knowledgeScore(a, queryText)))
                .filter(page -> knowledgeScore(page, queryText) > 0)
                .limit(6)
                .toList();
        if (selected.isEmpty()) {
            selected = pages.stream().limit(4).toList();
        }
        for (UserKnowledgePage page : selected) {
            String content = cryptoService.decrypt(page.getEncryptedContent());
            if (hasText(content)) {
                parts.add("[" + page.getPageType() + "] " + page.getTitle() + "\n" + limitText(content, 800));
            }
        }
        return limitText(String.join("\n\n", parts), 4000);
    }

    private void upsertMemory(Long userId, String memoryText) {
        UserAiMemory memory = getMemoryEntity(userId);
        if (memory == null) {
            memory = new UserAiMemory();
            memory.setUserId(userId);
            memory.setMemoryText(null);
            memory.setEncryptedMemoryText(hasText(memoryText) ? cryptoService.encrypt(memoryText.trim()) : null);
            memory.setEncryptionVersion("v1");
            memoryMapper.insert(memory);
        } else {
            memory.setMemoryText(null);
            memory.setEncryptedMemoryText(hasText(memoryText) ? cryptoService.encrypt(memoryText.trim()) : null);
            memory.setEncryptionVersion("v1");
            memoryMapper.updateById(memory);
        }
    }

    private String decryptMemory(UserAiMemory memory) {
        if (memory == null) {
            return "";
        }
        if (hasText(memory.getEncryptedMemoryText())) {
            return cryptoService.decrypt(memory.getEncryptedMemoryText());
        }
        return memory.getMemoryText() == null ? "" : memory.getMemoryText();
    }

    private String limitedQuery(String message) {
        return limitText(message == null ? "" : message.replaceAll("\\s+", " ").trim(), 260);
    }

    private int knowledgeScore(UserKnowledgePage page, String queryText) {
        int score = page.getPinned() != null && page.getPinned() == 1 ? 2 : 0;
        String query = normalizeSearchText(queryText);
        if (!hasText(query)) {
            return score;
        }
        String title = normalizeSearchText(page.getTitle());
        String summary = normalizeSearchText(page.getContentSummary());
        if (hasText(title) && (title.contains(query) || query.contains(title))) {
            score += 8;
        }
        if (hasText(summary) && (summary.contains(query) || query.contains(summary))) {
            score += 4;
        }
        for (String token : query.split("[,，。；;、\\s]+")) {
            if (token.length() < 2) {
                continue;
            }
            if (title.contains(token)) score += 3;
            if (summary.contains(token)) score += 2;
        }
        return score;
    }

    private String normalizeSearchText(String value) {
        return value == null ? "" : value.toLowerCase(Locale.ROOT)
                .replaceAll("[\\p{Punct}\\s]+", " ")
                .trim();
    }

    private boolean looksWikiWriteIntent(String message) {
        if (!hasText(message)) {
            return false;
        }
        String text = message.toLowerCase(Locale.ROOT).replaceAll("\\s+", "");
        boolean mentionsWiki = text.contains("知识wiki")
                || text.contains("wiki")
                || text.contains("知识库")
                || text.contains("知识树");
        boolean asksWrite = text.contains("写进")
                || text.contains("写入")
                || text.contains("存入")
                || text.contains("保存")
                || text.contains("收录")
                || text.contains("放进")
                || text.contains("放到")
                || text.contains("加入")
                || text.contains("整理到")
                || text.contains("同步到")
                || text.contains("记到")
                || text.contains("记进");
        return mentionsWiki && asksWrite;
    }

    private UserKnowledgeRevision createWikiDraftRevision(Long userId,
                                                          Long conversationId,
                                                          Long sourceMessageId,
                                                          String userMessage,
                                                          String assistantReply,
                                                          List<AiMessage> history) {
        String previousAssistant = latestAssistantContent(history);
        String content = extractWikiDraftContent(userMessage, assistantReply, previousAssistant);
        String title = inferWikiDraftTitle(userMessage, content);
        KnowledgeSource source = new KnowledgeSource();
        source.setUserId(userId);
        source.setSourceType("CHAT");
        source.setTitle(limitText("对话来源：" + title, 180));
        source.setSourceRef("conversation:" + conversationId + "/message:" + sourceMessageId);
        source.setEncryptedContent(cryptoService.encrypt(limitText("用户：\n" + userMessage + "\n\n助手：\n" + assistantReply, 12000)));
        source.setEncryptionVersion("v1");
        source.setContentSummary(limitText(cleanWikiDraftContent(content).replaceAll("\\s+", " "), 780));
        source.setConversationId(conversationId);
        source.setMessageId(sourceMessageId);
        source.setImmutableHash(sha256(source.getSourceRef() + "\n" + userMessage + "\n" + assistantReply));
        knowledgeSourceMapper.insert(source);

        KnowledgePatchSet patchSet = new KnowledgePatchSet();
        patchSet.setUserId(userId);
        patchSet.setTitle(title);
        patchSet.setSummary(limitText(cleanWikiDraftContent(content).replaceAll("\\s+", " "), 900));
        patchSet.setStatus("PENDING");
        patchSet.setTriggerType("CHAT");
        patchSet.setSourceMessageId(sourceMessageId);
        patchSet.setSourceConversationId(conversationId);
        knowledgePatchSetMapper.insert(patchSet);

        UserKnowledgeRevision revision = new UserKnowledgeRevision();
        revision.setUserId(userId);
        revision.setPatchSetId(patchSet.getId());
        revision.setActionType("UPSERT");
        revision.setTitle(patchSet.getTitle());
        revision.setEncryptedContent(cryptoService.encrypt(limitText(content, 5000)));
        revision.setEncryptionVersion("v1");
        revision.setStatus("PENDING");
        revision.setSourceMessageId(sourceMessageId);
        revision.setSourceConversationId(conversationId);
        knowledgeRevisionMapper.insert(revision);
        return revision;
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
        } catch (NoSuchAlgorithmException e) {
            return Integer.toHexString(String.valueOf(text).hashCode());
        }
    }

    private String latestAssistantContent(List<AiMessage> history) {
        if (history == null || history.isEmpty()) {
            return "";
        }
        for (int i = history.size() - 1; i >= 0; i--) {
            AiMessage item = history.get(i);
            if (item != null && "assistant".equalsIgnoreCase(item.getRole()) && hasText(item.getContent())) {
                return item.getContent();
            }
        }
        return "";
    }

    private String extractWikiDraftContent(String userMessage, String assistantReply, String previousAssistant) {
        String content = extractAfterWikiSummaryMarker(assistantReply);
        if (!hasText(content) || (isProbablyOnlyWikiConfirmation(content) && hasText(previousAssistant))) {
            content = previousAssistant;
        }
        if (!hasText(content)) {
            content = assistantReply;
        }
        if (!hasText(content)) {
            content = userMessage;
        }
        return cleanWikiDraftContent(content);
    }

    private String extractAfterWikiSummaryMarker(String text) {
        if (!hasText(text)) {
            return "";
        }
        String[] markers = {
                "已存入内容摘要：",
                "已存入内容摘要:",
                "内容摘要：",
                "内容摘要:",
                "摘要：",
                "摘要:"
        };
        for (String marker : markers) {
            int index = text.indexOf(marker);
            if (index >= 0) {
                return text.substring(index + marker.length());
            }
        }
        return text;
    }

    private boolean isProbablyOnlyWikiConfirmation(String text) {
        if (!hasText(text)) {
            return true;
        }
        String compact = text.replaceAll("\\s+", "");
        boolean saysStored = compact.contains("已将")
                || compact.contains("已经")
                || compact.contains("已整理")
                || compact.contains("已存入")
                || compact.contains("已写入");
        boolean mentionsWiki = compact.toLowerCase(Locale.ROOT).contains("wiki")
                || compact.contains("知识库")
                || compact.contains("知识树");
        return compact.length() < 220 && saysStored && mentionsWiki;
    }

    private String cleanWikiDraftContent(String text) {
        String cleaned = cleanMemoryText(text);
        cleaned = cleaned.replace("\r\n", "\n");
        cleaned = cleanOrphanMarkdownMarkers(cleaned);
        List<String> lines = new ArrayList<>();
        for (String line : cleaned.split("\n")) {
            String compact = line.replaceAll("\\s+", "");
            boolean skipConfirmation = (compact.contains("已将") || compact.contains("已经") || compact.contains("已存入") || compact.contains("已写入"))
                    && (compact.toLowerCase(Locale.ROOT).contains("wiki") || compact.contains("知识库") || compact.contains("知识树"));
            boolean skipRecallHint = compact.contains("下次") && (compact.contains("调取") || compact.contains("查阅"));
            if (!skipConfirmation && !skipRecallHint) {
                lines.add(line);
            }
        }
        cleaned = String.join("\n", lines).trim();
        cleaned = cleanOrphanMarkdownMarkers(cleaned);
        return hasText(cleaned) ? cleaned : limitText(text, 5000);
    }

    private String cleanOrphanMarkdownMarkers(String text) {
        if (!hasText(text)) {
            return "";
        }
        return text
                .replaceAll("(?m)^\\s*(\\*\\*|__)\\s*$\\n?", "")
                .replaceAll("(?m)([：:])\\s*(\\*\\*|__)\\s*$", "$1")
                .replaceFirst("^\\s*(\\*\\*|__)\\s+(?=[\\-+*•·])", "")
                .replaceAll("(?m)^\\s*(\\*\\*|__)\\s+([\\-+*•·])", "$2")
                .trim();
    }

    private String inferWikiDraftTitle(String userMessage, String content) {
        String source = (valueOr(userMessage, "") + "\n" + valueOr(content, "")).replaceAll("\\s+", "");
        if (source.contains("暑假") && source.contains("考研") && source.contains("保底")) {
            return "暑假考研保底计划";
        }
        if (source.contains("暑假") && source.contains("考研")) {
            return "暑假考研计划";
        }
        if (source.contains("考研") && source.contains("计划")) {
            return "考研计划";
        }
        if (source.contains("计划")) {
            return "学习计划";
        }
        if (source.contains("偏好")) {
            return "学习偏好";
        }
        if (source.contains("目标")) {
            return "长期目标";
        }
        return "对话整理";
    }

    private String buildWikiDraftReply(UserKnowledgeRevision revision, String content) {
        String preview = limitText(cleanWikiDraftContent(content), 700);
        return """
                我已经把这段内容整理成一条知识 Wiki 待确认草稿：「%s」。

                它现在还没有永久写入知识树。你可以打开“知识 Wiki”，像编辑文档一样修改标题、父节点和正文，然后保存合入。

                草稿摘要：
                %s
                """.formatted(revision.getTitle(), preview);
    }

    private Map<String, Object> chatWikiRevisionRow(UserKnowledgeRevision revision) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", revision.getId());
        row.put("title", revision.getTitle());
        row.put("status", revision.getStatus());
        row.put("sourceConversationId", revision.getSourceConversationId());
        row.put("patchSetId", revision.getPatchSetId());
        return row;
    }

    private void maybeUpdateLongTermMemory(AiModelConfig config, Long userId, String userMessage, String assistantReply) {
        if (!looksMemoryWorthy(userMessage)) {
            return;
        }
        try {
            String currentMemory = getMemoryText(userId);
            String prompt = """
                    你是长期记忆整理器。请根据用户新消息和当前记忆，更新一份给学习助手使用的长期记忆。
                    只记录长期稳定信息，例如目标考试、年份、科目、薄弱科目、学习偏好、提醒偏好、长期项目。
                    不记录一次性问题、闲聊、隐私敏感内容、临时情绪。
                    使用简洁中文项目符号。总长度不超过 1200 字。
                    如果没有值得记录的新信息，原样返回当前记忆；如果当前记忆为空且没有新信息，返回空字符串。
                    """;
            String input = """
                    当前长期记忆：
                    %s

                    用户新消息：
                    %s

                    助手回复摘要：
                    %s
                    """.formatted(
                    hasText(currentMemory) ? currentMemory : "",
                    userMessage,
                    limitText(assistantReply, 1000)
            );
            String updatedMemory = limitText(cleanMemoryText(callAiApi(config, prompt, input)), MEMORY_MAX_LENGTH);
            if (hasText(updatedMemory) && !updatedMemory.equals(currentMemory)) {
                UserKnowledgeRevision revision = new UserKnowledgeRevision();
                revision.setUserId(userId);
                revision.setActionType("UPSERT");
                revision.setTitle("对话提炼记忆");
                revision.setEncryptedContent(cryptoService.encrypt(updatedMemory));
                revision.setEncryptionVersion("v1");
                revision.setStatus("PENDING");
                knowledgeRevisionMapper.insert(revision);
            }
        } catch (Exception ignored) {
            // 记忆整理失败不影响主聊天。
        }
    }

    private boolean looksMemoryWorthy(String message) {
        if (!hasText(message)) {
            return false;
        }
        String text = message.toLowerCase(Locale.ROOT);
        return text.contains("记住")
                || text.contains("我的目标")
                || text.contains("我希望")
                || text.contains("我不喜欢")
                || text.contains("我准备")
                || text.contains("我打算")
                || text.contains("我计划")
                || text.contains("考研")
                || text.contains("薄弱")
                || text.contains("偏好")
                || text.contains("ddl");
    }

    private Map<String, Object> suggestPlanFromChatIfNeeded(AiModelConfig config, String userMessage, String assistantReply) {
        Map<String, Object> empty = new HashMap<>();
        empty.put("tasks", List.of());
        empty.put("routines", List.of());
        if (!looksTaskCreationIntent(userMessage)) {
            return empty;
        }
        String userPrompt = """
                用户刚才的请求：
                %s

                助手刚才给出的计划：
                %s
                """.formatted(userMessage, assistantReply);
        // 优先走真正的工具调用（Function Calling）：把 create_study_plan 的 tools schema 发给模型，
        // 由模型自己决定并返回 tool_call，后端解析其 arguments 落成计划草稿（保留用户确认后落库）。
        // OpenAI 协议兼容；不支持工具的提供方或调用失败时，回退到下面的结构化输出方案。
        if (!"ANTHROPIC".equals(normalizeProviderType(config.getProviderType()))) {
            try {
                String toolArgs = callStudyPlanToolCall(config, getStudyPlanToolSystemPrompt(), userPrompt);
                if (hasText(toolArgs)) {
                    return parsePlanFromResponse(toolArgs);
                }
            } catch (Exception ignored) {
                // 该模型/网关不支持 tools 或调用失败，回退到结构化输出
            }
        }
        try {
            String aiResponse = callAiApi(config, getChatTaskExtractionPrompt(), userPrompt);
            return parsePlanFromResponse(aiResponse);
        } catch (Exception ignored) {
            // 对话本身已经成功，任务抽取失败时不影响聊天回复。
            return empty;
        }
    }

    /**
     * 真正的 Function Calling：以 OpenAI 工具调用协议发送 create_study_plan 的 schema，
     * 强制 tool_choice 保证拿到结构化 tool_call，返回其 arguments 的 JSON 字符串（与 {tasks,routines} 同形）。
     * 无 tool_call 时返回空串，交由上层回退。
     */
    private String callStudyPlanToolCall(AiModelConfig config, String systemPrompt, String userMessage) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        String apiKey = decryptedApiKey(config);
        if (hasText(apiKey)) {
            headers.setBearerAuth(apiKey);
        }
        Map<String, Object> body = new HashMap<>();
        body.put("model", config.getModelName());
        body.put("messages", List.of(
                Map.of("role", "system", "content", systemPrompt),
                Map.of("role", "user", "content", userMessage)));
        body.put("temperature", 0.2);
        body.put("max_tokens", 4096);
        body.put("tools", buildCreateStudyPlanTools());
        // 已判定为写计划意图，强制模型调用该工具，稳定拿到结构化调用参数
        body.put("tool_choice", Map.of("type", "function", "function", Map.of("name", "create_study_plan")));
        try {
            HttpEntity<Map<String, Object>> request = new HttpEntity<>(body, headers);
            ResponseEntity<String> response = restTemplate.postForEntity(
                    resolveChatCompletionsUrl(config.getApiUrl()), request, String.class);
            JsonNode toolCalls = objectMapper.readTree(response.getBody()).at("/choices/0/message/tool_calls");
            if (!toolCalls.isArray() || toolCalls.isEmpty()) {
                return "";
            }
            JsonNode chosen = null;
            for (JsonNode call : toolCalls) {
                if ("create_study_plan".equals(call.at("/function/name").asText(""))) {
                    chosen = call;
                    break;
                }
            }
            if (chosen == null) {
                chosen = toolCalls.get(0);
            }
            JsonNode args = chosen.at("/function/arguments");
            // OpenAI 规范里 arguments 是 JSON 字符串；个别网关直接给对象，两种都兼容
            if (args.isTextual()) {
                return args.asText("");
            }
            return args.isMissingNode() ? "" : args.toString();
        } catch (RestClientResponseException e) {
            throw new BusinessException(formatAiHttpError(e));
        } catch (Exception e) {
            // 解析失败等一律上抛，由调用方回退到结构化输出
            throw new BusinessException("工具调用失败：" + e.getMessage());
        }
    }

    /** create_study_plan 工具的 OpenAI schema：模型据此决定并填充一次性任务与例行计划 */
    private List<Map<String, Object>> buildCreateStudyPlanTools() {
        Map<String, Object> taskProps = new LinkedHashMap<>();
        taskProps.put("title", schemaProp("string", "任务标题，简洁明确"));
        taskProps.put("description", schemaProp("string", "任务说明，含背景/范围/验收标准"));
        taskProps.put("startTime", schemaProp("string", "YYYY-MM-DD HH:mm:ss 开始时间，无法确定则省略"));
        taskProps.put("deadline", schemaProp("string", "YYYY-MM-DD HH:mm:ss 截止时间，无法确定则省略"));
        taskProps.put("durationMinutes", schemaProp("integer", "预计时长（分钟）"));
        taskProps.put("taskType", schemaProp("string", "assignment/exam/report/presentation/course/activity/other 中最接近的一类"));
        taskProps.put("difficulty", schemaProp("integer", "1..5，1很简单 5很复杂"));
        taskProps.put("suggestedReminderOffsets", schemaArray("integer", "提前提醒天数，如 [7,4,2]；无 deadline 则为空数组"));
        taskProps.put("reminderReason", schemaProp("string", "提醒节奏的一句话理由"));
        taskProps.put("priority", schemaProp("integer", "0低 1中 2高"));
        taskProps.put("suggestedQuadrant", schemaProp("integer", "1重要且紧急 2重要不紧急 3紧急不重要 4不重要不紧急"));
        taskProps.put("reason", schemaProp("string", "象限建议的一句话理由"));
        Map<String, Object> taskItem = new LinkedHashMap<>();
        taskItem.put("type", "object");
        taskItem.put("properties", taskProps);
        taskItem.put("required", List.of("title"));

        Map<String, Object> routineProps = new LinkedHashMap<>();
        routineProps.put("title", schemaProp("string", "例行计划标题，如 每天背单词"));
        routineProps.put("description", schemaProp("string", "例行计划说明"));
        routineProps.put("frequency", schemaEnum("重复频率", "DAILY", "WEEKLY"));
        routineProps.put("daysOfWeek", schemaArray("integer", "周一=1..周日=7；DAILY 可为空数组"));
        routineProps.put("startDate", schemaProp("string", "YYYY-MM-DD"));
        routineProps.put("endDate", schemaProp("string", "YYYY-MM-DD，无法确定则用今天起 30 天后"));
        routineProps.put("preferredTime", schemaProp("string", "HH:mm，无法确定则省略"));
        routineProps.put("durationMinutes", schemaProp("integer", "预计时长（分钟）"));
        routineProps.put("taskType", schemaProp("string", "assignment/exam/report/presentation/course/activity/other"));
        routineProps.put("difficulty", schemaProp("integer", "1..5"));
        routineProps.put("priority", schemaProp("integer", "0低 1中 2高"));
        routineProps.put("suggestedQuadrant", schemaProp("integer", "1..4"));
        routineProps.put("reminderEnabled", schemaProp("boolean", "是否开启提醒"));
        routineProps.put("reminderOffsets", schemaArray("integer", "提醒偏移，通常 [0]"));
        routineProps.put("reminderReason", schemaProp("string", "为何适合做成例行计划"));
        Map<String, Object> routineItem = new LinkedHashMap<>();
        routineItem.put("type", "object");
        routineItem.put("properties", routineProps);
        routineItem.put("required", List.of("title", "frequency"));

        Map<String, Object> props = new LinkedHashMap<>();
        props.put("tasks", schemaArrayOf(taskItem, "一次性任务/里程碑：有明确 DDL 或阶段交付物的项目"));
        props.put("routines", schemaArrayOf(routineItem, "每天/每周重复执行的例行计划，不要展开成大量 tasks"));
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("type", "object");
        params.put("properties", props);
        params.put("required", List.of("tasks", "routines"));

        Map<String, Object> function = new LinkedHashMap<>();
        function.put("name", "create_study_plan");
        function.put("description", "把用户认可的学习计划拆解为可写入知趣系统的一次性任务(tasks)和例行计划(routines)，"
                + "生成草稿供用户确认后落库。当用户希望把计划写进系统时调用；没有可落地项时两个数组都传空。");
        function.put("parameters", params);

        Map<String, Object> tool = new LinkedHashMap<>();
        tool.put("type", "function");
        tool.put("function", function);
        return List.of(tool);
    }

    private Map<String, Object> schemaProp(String type, String description) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", type);
        m.put("description", description);
        return m;
    }

    private Map<String, Object> schemaArray(String itemType, String description) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", "array");
        m.put("items", Map.of("type", itemType));
        m.put("description", description);
        return m;
    }

    private Map<String, Object> schemaArrayOf(Map<String, Object> item, String description) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", "array");
        m.put("items", item);
        m.put("description", description);
        return m;
    }

    private Map<String, Object> schemaEnum(String description, String... values) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", "string");
        m.put("enum", List.of(values));
        m.put("description", description);
        return m;
    }

    private String getStudyPlanToolSystemPrompt() {
        String today = LocalDate.now(ZoneId.of("Asia/Shanghai")).toString();
        return """
                你是「知趣·象限学习系统」的计划落库助手。今天是 %s，时区 Asia/Shanghai。
                你会收到用户的计划创建请求和助手刚给出的学习计划。请判断其中真正适合写入系统的内容，
                并调用 create_study_plan 工具提交：有明确 DDL、阶段交付物、考试、报告的进入 tasks；
                每天、每周、长期重复执行的学习动作进入 routines，不要展开成大量 tasks。

                规则：
                - 只提交真正可落地的项目，不要把闲聊、解释、纯建议写进去；没有可落地项则 tasks 和 routines 都传空数组。
                - 只有日期没有具体时间时，deadline 用当天 23:59:59；“7月1日前”“本周日之前”等相对时间按今天换算成具体 deadline。
                - 长期阶段（如“基础期 2026.7-2027.3”）可生成阶段末检查任务，deadline 为该阶段最后一天 23:59:59。
                - 提醒偏移：考试/报告/难度4-5 用 [14,7,4,2,1]；普通作业/难度3 用 [7,4,2]；简单任务 用 [4,2,1]；无 deadline 用 []。
                - 象限：1 重要且紧急，2 重要不紧急，3 紧急不重要，4 不重要不紧急。
                """.formatted(today);
    }

    private boolean looksTaskCreationIntent(String message) {
        if (!hasText(message)) {
            return false;
        }
        String text = message.toLowerCase(Locale.ROOT);
        boolean asksPlan = text.contains("计划")
                || text.contains("规划")
                || text.contains("安排")
                || text.contains("拆")
                || text.contains("任务")
                || text.contains("ddl")
                || text.contains("deadline");
        boolean asksCreate = text.contains("生成")
                || text.contains("写到")
                || text.contains("写入")
                || text.contains("加入")
                || text.contains("添加")
                || text.contains("创建")
                || text.contains("放到")
                || text.contains("导入")
                || text.contains("过目");
        return asksPlan && asksCreate;
    }

    private String cleanMemoryText(String text) {
        if (!hasText(text)) {
            return "";
        }
        String cleaned = text.trim();
        if (cleaned.startsWith("```")) {
            cleaned = cleaned.replaceFirst("^```[A-Za-z0-9_-]*\\s*", "")
                    .replaceFirst("\\s*```$", "");
        }
        return cleaned.trim();
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
                    "startTime": "YYYY-MM-DD HH:mm:ss 格式的开始时间，如果无法确定则为 null",
                    "deadline": "YYYY-MM-DD HH:mm:ss 格式的截止/结束时间，如果无法确定则为 null",
                    "durationMinutes": 持续时长（分钟），整数，如果无法确定则为 null,
                    "repeatWeeks": 持续周数，整数。单次任务为 null；每周重复的课程填写周数,
                    "taskType": "assignment/exam/report/presentation/course/activity/other 中最接近的一类",
                    "difficulty": 1到5的数字，1很简单，5很复杂,
                    "suggestedReminderOffsets": [提前提醒天数数组，例如 [7,4,2]],
                    "reminderReason": "为什么这样设置提醒节奏（一句话）",
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

                时间识别规则：
                - 如果内容中有明确的上课/活动时间（如"周一 8:00-9:30 高等数学"），提取 startTime，并根据结束时间计算 durationMinutes
                - 如果只有日期没有具体时间（如"4月15日交作业"），startTime 设为 null，deadline 设为该日期 23:59:59
                - 如果是周期性课表（如"每周一 8:00"），按最近一周生成具体日期的任务
                - durationMinutes 常见参考：大学课程通常 45 或 90 分钟，自习通常 120 分钟
                - 如果完全无法判断时长，durationMinutes 设为 null
                - startTime 和 deadline 都允许为 null，两者独立存在
                - 如果课表中标注了周数（如"第1-16周"、"共18周"），提取为 repeatWeeks
                - 如果没有标注周数但明显是学期课程（有上课时间、课程名），默认 repeatWeeks 为 16
                - 如果是单次作业、考试、活动、一次性任务，repeatWeeks 设为 null
                - 当 repeatWeeks 不为 null 时，startTime 必须为第一周该课程的具体日期和时间

                提醒建议规则：
                - 考试、报告、展示、论文、难度4-5：suggestedReminderOffsets 返回 [14,7,4,2,1]
                - 普通作业、难度3：返回 [7,4,2]
                - 简单任务、难度1-2：返回 [4,2,1]
                - 如果没有明确 deadline，suggestedReminderOffsets 返回 []
                - reminderReason 要解释任务类型、难度和截止时间共同导致的提醒节奏

                表格/CSV 识别规则：
                - 如果内容来自表格，请按行列关系识别课程名、作业名、日期、周次、地点、备注中的 DDL 信息
                - 表格单元格缺失时可以结合表头推断，但不确定的日期/时间不要编造
                """;
    }

    private String getChatTaskExtractionPrompt() {
        String today = LocalDate.now(ZoneId.of("Asia/Shanghai")).toString();
        return """
                你是「知趣·象限学习系统」的计划转任务助手。
                今天是 %s，时区是 Asia/Shanghai。

                你会收到用户在聊天里提出的计划创建请求，以及助手刚刚给出的学习计划。
                请把其中适合写入系统的内容，整理成用户可过目的“一次性任务”和“例行计划”。

                请严格按以下 JSON 对象格式返回，不要包含任何其他文字，不要用 markdown 代码块包裹：
                {
                  "tasks": [
                    {
                      "title": "任务标题，简洁明确",
                      "description": "任务说明，包含必要背景、范围或验收标准",
                      "startTime": "YYYY-MM-DD HH:mm:ss 格式的开始时间，如果无法确定则为 null",
                      "deadline": "YYYY-MM-DD HH:mm:ss 格式的截止时间，如果无法确定则为 null",
                      "durationMinutes": 持续时长（分钟），整数，如果无法确定则为 null,
                      "repeatWeeks": null,
                      "taskType": "assignment/exam/report/presentation/course/activity/other 中最接近的一类",
                      "difficulty": 1到5的数字，1很简单，5很复杂,
                      "suggestedReminderOffsets": [提前提醒天数数组，例如 [7,4,2]],
                      "reminderReason": "为什么这样设置提醒节奏（一句话）",
                      "priority": 0到2的数字（0低1中2高）,
                      "suggestedQuadrant": 1到4的数字,
                      "reason": "你建议这个象限的理由（一句话）"
                    }
                  ],
                  "routines": [
                    {
                      "title": "例行计划标题，例如 每天背单词",
                      "description": "例行计划说明",
                      "frequency": "DAILY 或 WEEKLY",
                      "daysOfWeek": [1到7的数组，周一=1，周日=7。DAILY 可为空数组],
                      "startDate": "YYYY-MM-DD",
                      "endDate": "YYYY-MM-DD，如果无法确定则用今天起30天后的日期",
                      "preferredTime": "HH:mm，如果无法确定则为 null",
                      "durationMinutes": 预计时长，整数，如果无法确定则为 null,
                      "taskType": "assignment/exam/report/presentation/course/activity/other 中最接近的一类",
                      "difficulty": 1到5的数字,
                      "priority": 0到2的数字,
                      "suggestedQuadrant": 1到4的数字,
                      "reminderEnabled": true,
                      "reminderOffsets": [0],
                      "reminderReason": "为什么适合做成例行计划（一句话）"
                    }
                  ]
                }

                转换规则：
                - 只生成真正适合进入系统的项目，不要把闲聊、解释性段落、纯建议写进去。
                - 用户说“给我过目”“写到学习任务里”“生成计划”时，可以把计划拆成 3 到 12 个阶段性任务或里程碑。
                - 有明确 DDL、阶段结束点、交付物、考试、报告的内容进入 tasks。
                - 每天、每周、每周几、长期重复执行的学习动作进入 routines，不要展开成大量 tasks。
                - 如果计划只有日期没有具体时间，deadline 使用当天 23:59:59。
                - 如果计划有“7月1日前”“本周日之前”等相对时间，请结合今天日期换算成具体 deadline。
                - 如果只是长期规划阶段，比如“基础期 2026.7-2027.3”，可以生成阶段末检查任务，deadline 为该阶段最后一天 23:59:59。
                - 如果没有任何可落地项目，返回 {"tasks":[],"routines":[]}。

                提醒建议规则：
                - 考试、报告、展示、论文、难度4-5：suggestedReminderOffsets 返回 [14,7,4,2,1]
                - 普通作业、难度3：返回 [7,4,2]
                - 简单任务、难度1-2：返回 [4,2,1]
                - 长期阶段性任务可以返回 [14,7,4,2]
                - 如果没有明确 deadline，suggestedReminderOffsets 返回 []
                - reminderReason 要解释任务类型、难度和截止时间共同导致的提醒节奏

                象限说明：
                1 = 重要且紧急
                2 = 重要不紧急
                3 = 紧急不重要
                4 = 不重要不紧急
                """.formatted(today);
    }

    /** 从 AI 响应中解析结构化任务列表 */
    private List<Map<String, Object>> parseTasksFromResponse(String aiResponse) {
        try {
            String jsonStr = extractJsonArray(aiResponse);
            JsonNode array = objectMapper.readTree(jsonStr);
            return parseTasksFromNode(array);
        } catch (Exception e) {
            throw new BusinessException("AI 返回格式解析失败，请重试");
        }
    }

    private Map<String, Object> parsePlanFromResponse(String aiResponse) {
        try {
            JsonNode root = objectMapper.readTree(extractJsonObject(aiResponse));
            Map<String, Object> plan = new HashMap<>();
            plan.put("tasks", parseTasksFromNode(root.get("tasks")));
            plan.put("routines", parseRoutinesFromNode(root.get("routines")));
            return plan;
        } catch (Exception e) {
            throw new BusinessException("AI 计划格式解析失败，请重试");
        }
    }

    private List<Map<String, Object>> parseTasksFromNode(JsonNode array) {
        try {
            List<Map<String, Object>> tasks = new ArrayList<>();
            if (array == null || !array.isArray()) {
                return tasks;
            }
            for (JsonNode node : array) {
                Map<String, Object> task = new HashMap<>();
                task.put("title", node.has("title") ? node.get("title").asText() : "");
                task.put("description", node.has("description") ? node.get("description").asText() : "");
                task.put("startTime", node.has("startTime") && !node.get("startTime").isNull()
                        ? node.get("startTime").asText() : null);
                task.put("deadline", node.has("deadline") && !node.get("deadline").isNull()
                        ? node.get("deadline").asText() : null);
                task.put("durationMinutes", node.has("durationMinutes") && !node.get("durationMinutes").isNull()
                        ? node.get("durationMinutes").asInt() : null);
                task.put("repeatWeeks", node.has("repeatWeeks") && !node.get("repeatWeeks").isNull()
                        ? node.get("repeatWeeks").asInt() : null);
                String taskType = node.has("taskType") && !node.get("taskType").isNull()
                        ? node.get("taskType").asText() : "other";
                Integer difficulty = node.has("difficulty") && !node.get("difficulty").isNull()
                        ? node.get("difficulty").asInt(3) : 3;
                task.put("taskType", taskType);
                task.put("difficulty", Math.max(1, Math.min(5, difficulty)));
                List<Integer> offsets = parseOffsets(node.get("suggestedReminderOffsets"));
                if (offsets.isEmpty() && task.get("deadline") != null) {
                    offsets = reminderPlanService.suggestOffsets(taskType, difficulty);
                }
                task.put("suggestedReminderOffsets", offsets);
                task.put("reminderReason", node.has("reminderReason") ? node.get("reminderReason").asText() : "");
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

    private List<Map<String, Object>> parseRoutinesFromNode(JsonNode array) {
        List<Map<String, Object>> routines = new ArrayList<>();
        if (array == null || !array.isArray()) {
            return routines;
        }
        LocalDate today = LocalDate.now(ZoneId.of("Asia/Shanghai"));
        for (JsonNode node : array) {
            Map<String, Object> routine = new HashMap<>();
            routine.put("title", node.has("title") ? node.get("title").asText() : "");
            routine.put("description", node.has("description") ? node.get("description").asText() : "");
            routine.put("frequency", node.has("frequency") ? node.get("frequency").asText("DAILY") : "DAILY");
            routine.put("daysOfWeek", parseIntArray(node.get("daysOfWeek")));
            routine.put("startDate", node.has("startDate") && !node.get("startDate").isNull()
                    ? node.get("startDate").asText() : today.toString());
            routine.put("endDate", node.has("endDate") && !node.get("endDate").isNull()
                    ? node.get("endDate").asText() : today.plusDays(29).toString());
            routine.put("preferredTime", node.has("preferredTime") && !node.get("preferredTime").isNull()
                    ? node.get("preferredTime").asText() : null);
            routine.put("durationMinutes", node.has("durationMinutes") && !node.get("durationMinutes").isNull()
                    ? node.get("durationMinutes").asInt() : null);
            routine.put("taskType", node.has("taskType") ? node.get("taskType").asText("other") : "other");
            int difficulty = node.has("difficulty") ? node.get("difficulty").asInt(3) : 3;
            routine.put("difficulty", Math.max(1, Math.min(5, difficulty)));
            routine.put("priority", node.has("priority") ? node.get("priority").asInt(1) : 1);
            routine.put("suggestedQuadrant", node.has("suggestedQuadrant")
                    ? node.get("suggestedQuadrant").asInt(2) : 2);
            routine.put("quadrant", routine.get("suggestedQuadrant"));
            routine.put("reminderEnabled", !node.has("reminderEnabled") || node.get("reminderEnabled").asBoolean(true));
            List<Integer> offsets = parseOffsets(node.get("reminderOffsets"));
            routine.put("reminderOffsets", offsets.isEmpty() ? List.of(0) : offsets);
            routine.put("reminderReason", node.has("reminderReason") ? node.get("reminderReason").asText() : "");
            routines.add(routine);
        }
        return routines;
    }

    private List<Integer> parseIntArray(JsonNode node) {
        List<Integer> result = new ArrayList<>();
        if (node == null || !node.isArray()) {
            return result;
        }
        for (JsonNode item : node) {
            if (item.isNumber()) {
                result.add(item.asInt());
            }
        }
        return result;
    }

    private List<Integer> parseOffsets(JsonNode node) {
        List<Integer> offsets = new ArrayList<>();
        if (node == null || !node.isArray()) {
            return offsets;
        }
        for (JsonNode item : node) {
            if (!item.isNumber()) {
                continue;
            }
            int offset = item.asInt();
            if (offset >= 0 && offset <= 365 && !offsets.contains(offset)) {
                offsets.add(offset);
            }
        }
        offsets.sort(Comparator.reverseOrder());
        return offsets;
    }

    /** 调用 AI 文本接口（兼容 OpenAI / DeepSeek / 通义千问等） */
    private String callAiApi(AiModelConfig config, String systemPrompt, String userMessage) {
        return callAiApi(config, List.of(
                Map.of("role", "system", "content", systemPrompt),
                Map.of("role", "user", "content", userMessage)
        ));
    }

    /** 调用 AI 文本接口（可携带多轮历史） */
    private String callAiApi(AiModelConfig config, List<Map<String, Object>> messages) {
        return callAiApiDetailed(config, messages, "OFF").content();
    }

    private AiCallResult callAiApiDetailed(AiModelConfig config, List<Map<String, Object>> messages, String reasoningMode) {
        validateProviderRequestUrl(config.getApiUrl());
        if ("ANTHROPIC".equals(normalizeProviderType(config.getProviderType()))) {
            return callAnthropicApi(config, messages, reasoningMode);
        }
        return callOpenAiCompatibleApi(config, messages, reasoningMode);
    }

    @FunctionalInterface
    private interface StreamSink {
        void accept(NormalizedStreamEvent event);

        default void accept(String eventName, String text) {
            if ("reasoning.delta".equals(eventName)) {
                accept(NormalizedStreamEvent.reasoning(text));
            } else {
                accept(NormalizedStreamEvent.message(text));
            }
        }
    }

    private AiCallResult callAiApiStream(AiModelConfig config, List<Map<String, Object>> messages,
                                         String reasoningMode, StreamSink sink) {
        validateProviderRequestUrl(config.getApiUrl());
        ModelStreamResult result = modelStreamAdapterFactory
                .getAdapter(normalizeProviderType(config.getProviderType()))
                .stream(new ModelStreamRequest(config, decryptedApiKey(config), messages, reasoningMode, anthropicVersion), sink::accept);
        return new AiCallResult(result.content(), result.reasoningSummary());
    }

    private AiCallResult callOpenAiCompatibleApiStream(AiModelConfig config, List<Map<String, Object>> messages,
                                                       String reasoningMode, StreamSink sink) {
        StringBuilder content = new StringBuilder();
        StringBuilder reasoning = new StringBuilder();
        try {
            Map<String, Object> body = new HashMap<>();
            body.put("model", config.getModelName());
            body.put("messages", messages);
            body.put("temperature", 0.3);
            body.put("max_tokens", 4096);
            body.put("stream", true);
            applyOpenAiReasoningOptions(config, body, reasoningMode);

            restTemplate.execute(resolveChatCompletionsUrl(config.getApiUrl()), HttpMethod.POST, request -> {
                request.getHeaders().setContentType(MediaType.APPLICATION_JSON);
                String apiKey = decryptedApiKey(config);
                if (hasText(apiKey)) {
                    request.getHeaders().setBearerAuth(apiKey);
                }
                objectMapper.writeValue(request.getBody(), body);
            }, response -> {
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(response.getBody(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        if (!line.startsWith("data:")) {
                            continue;
                        }
                        String data = line.substring(5).trim();
                        if (data.isBlank() || "[DONE]".equals(data)) {
                            continue;
                        }
                        JsonNode root = objectMapper.readTree(data);
                        if (root.has("error")) {
                            throw new BusinessException(extractAiErrorDetail(root.toString()));
                        }
                        String delta = firstTextAt(root,
                                "/choices/0/delta/content",
                                "/choices/0/message/content");
                        if (hasText(delta)) {
                            content.append(delta);
                            sink.accept("message.delta", delta);
                        }
                        if (isReasoningRequested(reasoningMode)) {
                            String thought = firstTextAt(root,
                                    "/choices/0/delta/reasoning_content",
                                    "/choices/0/delta/reasoning",
                                    "/choices/0/message/reasoning_content");
                            if (hasText(thought)) {
                                reasoning.append(thought);
                                sink.accept("reasoning.delta", thought);
                            }
                        }
                    }
                }
                return null;
            });
            return new AiCallResult(content.toString(), reasoning.toString());
        } catch (BusinessException e) {
            throw e;
        } catch (Exception e) {
            return callOpenAiCompatibleApi(config, messages, reasoningMode);
        }
    }

    private AiCallResult callAnthropicApiStream(AiModelConfig config, List<Map<String, Object>> messages,
                                                String reasoningMode, StreamSink sink) {
        StringBuilder content = new StringBuilder();
        StringBuilder reasoning = new StringBuilder();
        try {
            Map<String, Object> body = anthropicBody(config, messages);
            body.put("stream", true);
            applyAnthropicThinkingOptions(body, reasoningMode);
            restTemplate.execute(resolveAnthropicMessagesUrl(config.getApiUrl()), HttpMethod.POST, request -> {
                request.getHeaders().putAll(anthropicHeaders(config));
                objectMapper.writeValue(request.getBody(), body);
            }, response -> {
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(response.getBody(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        if (!line.startsWith("data:")) {
                            continue;
                        }
                        String data = line.substring(5).trim();
                        if (data.isBlank() || "[DONE]".equals(data)) {
                            continue;
                        }
                        JsonNode root = objectMapper.readTree(data);
                        String type = root.path("type").asText("");
                        if ("error".equals(type)) {
                            throw new BusinessException(extractAiErrorDetail(root.toString()));
                        }
                        JsonNode delta = root.path("delta");
                        String text = firstText(delta.path("text"), root.path("content_block").path("text"));
                        if (hasText(text)) {
                            content.append(text);
                            sink.accept("message.delta", text);
                        }
                        if (isReasoningRequested(reasoningMode)) {
                            String thought = firstText(delta.path("thinking"), delta.path("text"));
                            String deltaType = delta.path("type").asText("");
                            if (hasText(thought) && (deltaType.contains("thinking") || "thinking_delta".equals(deltaType))) {
                                reasoning.append(thought);
                                sink.accept("reasoning.delta", thought);
                            }
                        }
                    }
                }
                return null;
            });
            return new AiCallResult(content.toString(), reasoning.toString());
        } catch (BusinessException e) {
            throw e;
        } catch (Exception e) {
            return callAnthropicApi(config, messages, reasoningMode);
        }
    }

    private AiCallResult callOpenAiCompatibleApi(AiModelConfig config, List<Map<String, Object>> messages, String reasoningMode) {
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            String apiKey = decryptedApiKey(config);
            if (hasText(apiKey)) {
                headers.setBearerAuth(apiKey);
            }

            Map<String, Object> body = new HashMap<>();
            body.put("model", config.getModelName());
            body.put("messages", messages);
            body.put("temperature", 0.3);
            body.put("max_tokens", 4096);
            applyOpenAiReasoningOptions(config, body, reasoningMode);

            HttpEntity<Map<String, Object>> request = new HttpEntity<>(body, headers);
            ResponseEntity<String> response = restTemplate.postForEntity(
                    resolveChatCompletionsUrl(config.getApiUrl()), request, String.class);

            JsonNode root = objectMapper.readTree(response.getBody());
            return new AiCallResult(extractOpenAiMessageContent(root),
                    isReasoningRequested(reasoningMode) ? extractOpenAiReasoning(root) : "");
        } catch (BusinessException e) {
            throw e;
        } catch (RestClientResponseException e) {
            throw new BusinessException(formatAiHttpError(e));
        } catch (Exception e) {
            throw new BusinessException("AI 接口调用失败：" + e.getMessage());
        }
    }

    /** 调用 AI 视觉接口（携带 Base64 图片，OpenAI Vision 格式） */
    private void applyOpenAiReasoningOptions(AiModelConfig config, Map<String, Object> body, String reasoningMode) {
        String name = config.getModelName() == null ? "" : config.getModelName().toLowerCase(Locale.ROOT);
        if (!isReasoningRequested(reasoningMode)) {
            if (name.contains("deepseek") && !name.contains("reasoner")) {
                body.put("thinking", Map.of("type", "disabled"));
            }
            return;
        }
        if (name.contains("deepseek") && !name.contains("reasoner")) {
            body.put("thinking", Map.of("type", "enabled"));
            return;
        }
        if (name.contains("deepseek-reasoner") || name.contains("reasoner")) {
            return;
        }
        if (name.startsWith("o1") || name.startsWith("o3") || name.startsWith("o4") || name.startsWith("gpt-5")) {
            body.put("reasoning", Map.of("effort", "DEEP".equals(reasoningMode) ? "high" : "medium"));
        }
    }

    private void applyAnthropicThinkingOptions(Map<String, Object> body, String reasoningMode) {
        if (isReasoningRequested(reasoningMode)) {
            body.put("thinking", Map.of(
                    "type", "enabled",
                    "budget_tokens", "DEEP".equals(reasoningMode) ? 2048 : 1024
            ));
        }
    }

    private String callAiApiWithVision(AiModelConfig config, String systemPrompt,
                                       List<Map<String, Object>> userContent) {
        if ("ANTHROPIC".equals(normalizeProviderType(config.getProviderType()))) {
            return callAnthropicVisionApi(config, systemPrompt, userContent);
        }
        try {
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            String apiKey = decryptedApiKey(config);
            if (hasText(apiKey)) {
                headers.setBearerAuth(apiKey);
            }

            Map<String, Object> body = new HashMap<>();
            body.put("model", config.getModelName());
            body.put("messages", List.of(
                    Map.of("role", "system", "content", systemPrompt),
                    Map.of("role", "user", "content", userContent)
            ));
            body.put("temperature", 0.3);
            body.put("max_tokens", 4096);

            HttpEntity<Map<String, Object>> request = new HttpEntity<>(body, headers);
            ResponseEntity<String> response = restTemplate.postForEntity(
                    resolveChatCompletionsUrl(config.getApiUrl()), request, String.class);

            JsonNode root = objectMapper.readTree(response.getBody());
            return extractOpenAiMessageContent(root);
        } catch (BusinessException e) {
            throw e;
        } catch (RestClientResponseException e) {
            String detail = extractAiErrorDetail(e.getResponseBodyAsString());
            String lowerDetail = detail.toLowerCase(Locale.ROOT);
            if (e.getStatusCode().value() == 400 &&
                    (lowerDetail.contains("image_url") || lowerDetail.contains("vision") || lowerDetail.contains("unsupported"))) {
                throw new BusinessException(
                        "当前模型不支持图片识别，请在个人中心切换为支持视觉的模型（如 gpt-4o、qwen-vl-plus）");
            }
            throw new BusinessException(formatAiHttpError(e));
        } catch (Exception e) {
            String msg = e.getMessage() != null ? e.getMessage() : "";
            if (msg.contains("400") || msg.contains("unsupported") || msg.contains("vision")) {
                throw new BusinessException(
                        "当前模型不支持图片识别，请在个人中心切换为支持视觉的模型（如 gpt-4o、qwen-vl-plus）");
            }
            throw new BusinessException("AI 接口调用失败：" + msg);
        }
    }

    private String normalizeAiApiUrl(String apiUrl) {
        String url = hasText(apiUrl) ? apiUrl.trim() : "https://api.openai.com/v1/chat/completions";
        return resolveChatCompletionsUrl(url);
    }

    private String resolveChatCompletionsUrl(String apiUrl) {
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

    private String resolveAnthropicMessagesUrl(String apiUrl) {
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

    private String extractOpenAiMessageContent(JsonNode root) {
        JsonNode content = root.at("/choices/0/message/content");
        if (!content.isMissingNode() && !content.isNull() && hasText(content.asText())) {
            return content.asText();
        }
        throw new BusinessException("AI 接口返回内容为空：" + limitText(root.toString(), 500));
    }

    private String extractOpenAiReasoning(JsonNode root) {
        JsonNode reasoning = root.at("/choices/0/message/reasoning_content");
        if (!reasoning.isMissingNode() && !reasoning.isNull() && hasText(reasoning.asText())) {
            return limitText(reasoning.asText(), 2000);
        }
        JsonNode alt = root.at("/choices/0/message/reasoning");
        if (!alt.isMissingNode() && !alt.isNull() && hasText(alt.asText())) {
            return limitText(alt.asText(), 2000);
        }
        return "";
    }

    private String firstTextAt(JsonNode root, String... paths) {
        if (root == null || paths == null) {
            return "";
        }
        for (String path : paths) {
            JsonNode node = root.at(path);
            String text = firstText(node);
            if (hasText(text)) {
                return text;
            }
        }
        return "";
    }

    private String firstText(JsonNode... nodes) {
        if (nodes == null) {
            return "";
        }
        for (JsonNode node : nodes) {
            if (node == null || node.isMissingNode() || node.isNull()) {
                continue;
            }
            String text = node.isTextual() ? node.asText("") : node.toString();
            if (hasText(text)) {
                return text;
            }
        }
        return "";
    }

    private AiCallResult callAnthropicApi(AiModelConfig config, List<Map<String, Object>> messages, String reasoningMode) {
        try {
            HttpHeaders headers = anthropicHeaders(config);
            Map<String, Object> body = anthropicBody(config, messages);
            applyAnthropicThinkingOptions(body, reasoningMode);
            ResponseEntity<String> response = restTemplate.postForEntity(
                    resolveAnthropicMessagesUrl(config.getApiUrl()),
                    new HttpEntity<>(body, headers),
                    String.class);
            AiCallResult result = extractAnthropicResult(objectMapper.readTree(response.getBody()));
            return new AiCallResult(result.content(), isReasoningRequested(reasoningMode) ? result.reasoningSummary() : "");
        } catch (BusinessException e) {
            throw e;
        } catch (RestClientResponseException e) {
            throw new BusinessException(formatAiHttpError(e));
        } catch (Exception e) {
            throw new BusinessException("Anthropic 接口调用失败：" + e.getMessage());
        }
    }

    private String callAnthropicVisionApi(AiModelConfig config, String systemPrompt,
                                          List<Map<String, Object>> userContent) {
        try {
            HttpHeaders headers = anthropicHeaders(config);
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("model", config.getModelName());
            body.put("max_tokens", 4096);
            body.put("temperature", 0.3);
            body.put("system", systemPrompt);
            body.put("messages", List.of(Map.of("role", "user", "content", toAnthropicContentBlocks(userContent))));
            ResponseEntity<String> response = restTemplate.postForEntity(
                    resolveAnthropicMessagesUrl(config.getApiUrl()),
                    new HttpEntity<>(body, headers),
                    String.class);
            return extractAnthropicContent(objectMapper.readTree(response.getBody()));
        } catch (BusinessException e) {
            throw e;
        } catch (RestClientResponseException e) {
            throw new BusinessException(formatAiHttpError(e));
        } catch (Exception e) {
            throw new BusinessException("Anthropic 视觉接口调用失败：" + e.getMessage());
        }
    }

    private HttpHeaders anthropicHeaders(AiModelConfig config) {
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

    private Map<String, Object> anthropicBody(AiModelConfig config, List<Map<String, Object>> messages) {
        StringBuilder system = new StringBuilder();
        List<Map<String, Object>> anthMessages = new ArrayList<>();
        for (Map<String, Object> message : messages) {
            String role = String.valueOf(message.getOrDefault("role", ""));
            Object content = message.get("content");
            if ("system".equals(role)) {
                if (content != null) {
                    if (system.length() > 0) {
                        system.append("\n\n");
                    }
                    system.append(content);
                }
            } else if ("user".equals(role) || "assistant".equals(role)) {
                anthMessages.add(Map.of("role", role, "content", String.valueOf(content == null ? "" : content)));
            }
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", config.getModelName());
        body.put("max_tokens", 4096);
        body.put("temperature", 0.3);
        if (system.length() > 0) {
            body.put("system", system.toString());
        }
        body.put("messages", anthMessages);
        return body;
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> toAnthropicContentBlocks(List<Map<String, Object>> userContent) {
        List<Map<String, Object>> blocks = new ArrayList<>();
        for (Map<String, Object> item : userContent) {
            String type = String.valueOf(item.getOrDefault("type", ""));
            if ("text".equals(type)) {
                blocks.add(Map.of("type", "text", "text", String.valueOf(item.getOrDefault("text", ""))));
            } else if ("image_url".equals(type) && item.get("image_url") instanceof Map<?, ?> imageUrl) {
                String url = String.valueOf(imageUrl.get("url"));
                int comma = url.indexOf(',');
                String meta = comma > 0 ? url.substring(0, comma) : "";
                String data = comma > 0 ? url.substring(comma + 1) : url;
                String mediaType = "image/png";
                if (meta.startsWith("data:") && meta.contains(";")) {
                    mediaType = meta.substring(5, meta.indexOf(';'));
                }
                blocks.add(Map.of(
                        "type", "image",
                        "source", Map.of(
                                "type", "base64",
                                "media_type", mediaType,
                                "data", data
                        )
                ));
            }
        }
        return blocks;
    }

    private String extractAnthropicContent(JsonNode root) {
        return extractAnthropicResult(root).content();
    }

    private AiCallResult extractAnthropicResult(JsonNode root) {
        JsonNode content = root.get("content");
        if (content != null && content.isArray()) {
            List<String> parts = new ArrayList<>();
            List<String> thinking = new ArrayList<>();
            for (JsonNode item : content) {
                String type = item.path("type").asText("");
                JsonNode text = item.get("text");
                if (text != null && text.isTextual() && hasText(text.asText())) {
                    if ("thinking".equals(type)) {
                        thinking.add(text.asText());
                    } else {
                        parts.add(text.asText());
                    }
                }
            }
            if (!parts.isEmpty()) {
                return new AiCallResult(String.join("\n", parts), limitText(String.join("\n", thinking), 2000));
            }
        }
        throw new BusinessException("Anthropic 接口返回内容为空：" + limitText(root.toString(), 500));
    }

    private String formatAiHttpError(RestClientResponseException e) {
        String detail = extractAiErrorDetail(e.getResponseBodyAsString());
        return "AI 接口调用失败（HTTP " + e.getStatusCode().value() + "）：" + detail;
    }

    private String extractAiErrorDetail(String responseBody) {
        if (!hasText(responseBody)) {
            return "接口没有返回错误详情";
        }
        try {
            JsonNode root = objectMapper.readTree(responseBody);
            JsonNode error = root.get("error");
            if (error != null) {
                if (error.isTextual()) {
                    return limitText(error.asText(), 500);
                }
                JsonNode message = error.get("message");
                JsonNode code = error.get("code");
                JsonNode type = error.get("type");
                List<String> parts = new ArrayList<>();
                if (message != null && !message.isNull()) parts.add(message.asText());
                if (code != null && !code.isNull()) parts.add("code=" + code.asText());
                if (type != null && !type.isNull()) parts.add("type=" + type.asText());
                if (!parts.isEmpty()) {
                    return limitText(String.join("；", parts), 500);
                }
            }
        } catch (Exception ignored) {
            // Fall back to raw body below.
        }
        return limitText(responseBody, 500);
    }

    private void ensureLegacyConfigMigrated(Long userId) {
        UserAiConfig legacy = configMapper.selectOne(
                new LambdaQueryWrapper<UserAiConfig>().eq(UserAiConfig::getUserId, userId)
        );
        if (legacy == null || !hasText(legacy.getApiKey())) {
            return;
        }
        AiModelConfig existing = getDefaultUserModel(userId);
        if (existing == null) {
            AiModelConfig model = new AiModelConfig();
            model.setUserId(userId);
            model.setOwnerType("USER");
            model.setProviderType(inferProviderType(legacy.getApiUrl()));
            model.setDisplayName(cleanModelDisplayName(hasText(legacy.getModelName()) ? legacy.getModelName() : "迁移模型"));
            model.setApiUrl(normalizeProviderApiUrl(legacy.getApiUrl(), model.getProviderType()));
            model.setEncryptedApiKey(cryptoService.encrypt(legacy.getApiKey()));
            model.setModelName(hasText(legacy.getModelName()) ? legacy.getModelName() : defaultModelName(model.getProviderType()));
            model.setCapabilities("TEXT,VISION");
            model.setEnabled(1);
            model.setIsDefault(1);
            model.setUsedToday(0);
            model.setEncryptionVersion("v1");
            modelConfigMapper.insert(model);
        }
        legacy.setApiKey(null);
        configMapper.updateById(legacy);
    }

    private AiModelConfig getDefaultUserModel(Long userId) {
        AiModelConfig model = modelConfigMapper.selectOne(new LambdaQueryWrapper<AiModelConfig>()
                .eq(AiModelConfig::getUserId, userId)
                .eq(AiModelConfig::getOwnerType, "USER")
                .eq(AiModelConfig::getIsDefault, 1)
                .eq(AiModelConfig::getEnabled, 1)
                .orderByDesc(AiModelConfig::getUpdatedAt)
                .last("LIMIT 1"));
        if (model != null) {
            return model;
        }
        return modelConfigMapper.selectOne(new LambdaQueryWrapper<AiModelConfig>()
                .eq(AiModelConfig::getUserId, userId)
                .eq(AiModelConfig::getOwnerType, "USER")
                .eq(AiModelConfig::getEnabled, 1)
                .orderByDesc(AiModelConfig::getUpdatedAt)
                .last("LIMIT 1"));
    }

    private void setDefaultUserModel(Long userId, Long modelId) {
        List<AiModelConfig> models = modelConfigMapper.selectList(new LambdaQueryWrapper<AiModelConfig>()
                .eq(AiModelConfig::getUserId, userId)
                .eq(AiModelConfig::getOwnerType, "USER"));
        for (AiModelConfig model : models) {
            model.setIsDefault(Objects.equals(model.getId(), modelId) ? 1 : 0);
            modelConfigMapper.updateById(model);
        }
    }

    private AiModelConfig systemModel() {
        if (!systemDefaultEnabled || !hasText(systemApiKey)) {
            return null;
        }
        AiModelConfig model = new AiModelConfig();
        model.setId(SYSTEM_MODEL_ID);
        model.setOwnerType("SYSTEM");
        model.setProviderType(normalizeProviderType(systemProviderType));
        model.setDisplayName(systemDisplayName);
        model.setApiUrl(normalizeProviderApiUrl(systemApiUrl, model.getProviderType()));
        model.setEncryptedApiKey(cryptoService.encrypt(systemApiKey));
        model.setModelName(systemModelName);
        model.setCapabilities("TEXT");
        model.setEnabled(1);
        model.setIsDefault(0);
        return model;
    }

    private Map<String, Object> modelRow(AiModelConfig model, boolean system) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", model.getId());
        row.put("ownerType", system ? "SYSTEM" : model.getOwnerType());
        row.put("providerType", model.getProviderType());
        String displayName = cleanModelDisplayName(model.getDisplayName());
        row.put("displayName", displayName);
        row.put("apiUrl", model.getApiUrl());
        row.put("apiKeyMasked", cryptoService.maskSecret(model.getEncryptedApiKey()));
        row.put("modelName", model.getModelName());
        row.put("capabilities", model.getCapabilities());
        row.put("capabilityProbeStatus", hasText(model.getCapabilityProbeStatus()) ? model.getCapabilityProbeStatus() : "UNTESTED");
        row.put("visionStatus", hasText(model.getVisionStatus()) ? model.getVisionStatus() : "UNTESTED");
        row.put("reasoningStatus", hasText(model.getReasoningStatus()) ? model.getReasoningStatus() : "UNTESTED");
        row.put("lastProbeAt", model.getLastProbeAt());
        row.put("enabled", model.getEnabled() != null && model.getEnabled() == 1);
        row.put("isDefault", model.getIsDefault() != null && model.getIsDefault() == 1);
        row.put("label", displayName + (system ? "（系统）" : "（我的）"));
        row.put("createdAt", model.getCreatedAt());
        row.put("updatedAt", model.getUpdatedAt());
        return row;
    }

    private String decryptedApiKey(AiModelConfig model) {
        if (model == null || !hasText(model.getEncryptedApiKey())) {
            return "";
        }
        return cryptoService.decrypt(model.getEncryptedApiKey());
    }

    private boolean hasCapability(AiModelConfig model, String capability) {
        String caps = model == null || model.getCapabilities() == null ? "" : model.getCapabilities().toUpperCase(Locale.ROOT);
        if (caps.contains(capability.toUpperCase(Locale.ROOT))) {
            return true;
        }
        String name = model == null || model.getModelName() == null ? "" : model.getModelName().toLowerCase(Locale.ROOT);
        return "VISION".equalsIgnoreCase(capability)
                && (name.contains("vision") || name.contains("vl") || name.contains("4o") || name.contains("claude-3"));
    }

    private String normalizeProviderType(String value) {
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

    private String cleanModelDisplayName(String value) {
        String text = hasText(value) ? value.trim() : "我的模型";
        while (text.endsWith("（我的）") || text.endsWith("(我的)") || text.endsWith("（系统）") || text.endsWith("(系统)")) {
            text = text
                    .replaceAll("（我的）$", "")
                    .replaceAll("\\(我的\\)$", "")
                    .replaceAll("（系统）$", "")
                    .replaceAll("\\(系统\\)$", "")
                    .trim();
        }
        return hasText(text) ? text : "我的模型";
    }

    private String inferProviderType(String apiUrl) {
        String url = apiUrl == null ? "" : apiUrl.toLowerCase(Locale.ROOT);
        if (url.contains("anthropic.com")) {
            return "ANTHROPIC";
        }
        if (url.contains("generativelanguage.googleapis.com") || url.contains("gemini")) {
            return "GEMINI";
        }
        if (url.contains("sensenova") || url.contains("sensetime")) {
            return "SENSENOVA";
        }
        if (url.contains("11434") || url.contains("ollama")) {
            return "OLLAMA";
        }
        if (url.endsWith("/responses") || url.contains("/responses")) {
            return "OPENAI_RESPONSES";
        }
        return "OPENAI_COMPATIBLE";
    }

    private String normalizeProviderApiUrl(String apiUrl, String providerType) {
        String type = normalizeProviderType(providerType);
        String url = hasText(apiUrl) ? apiUrl.trim() : defaultApiUrl(type);
        if ("ANTHROPIC".equals(type)) {
            return resolveAnthropicMessagesUrl(url);
        }
        if ("GEMINI".equals(type)) {
            return url;
        }
        if ("OPENAI_RESPONSES".equals(type)) {
            while (url.endsWith("/")) {
                url = url.substring(0, url.length() - 1);
            }
            if (url.endsWith("/responses")) {
                return url;
            }
            if (url.endsWith("/v1")) {
                return url + "/responses";
            }
            return url + "/v1/responses";
        }
        if ("OLLAMA".equals(type) && !url.endsWith("/chat/completions")) {
            while (url.endsWith("/")) {
                url = url.substring(0, url.length() - 1);
            }
            if (url.endsWith("/v1")) {
                return url + "/chat/completions";
            }
            return url + "/v1/chat/completions";
        }
        return resolveChatCompletionsUrl(url);
    }

    private void validateProviderRequestUrl(String apiUrl) {
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

    private boolean isLocalHostName(String host) {
        String value = host == null ? "" : host.trim().toLowerCase(Locale.ROOT);
        return "localhost".equals(value) || value.endsWith(".localhost")
                || "0.0.0.0".equals(value) || "::1".equals(value);
    }

    private boolean isPrivateAddress(InetAddress address) {
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

    private String defaultApiUrl(String providerType) {
        return switch (normalizeProviderType(providerType)) {
            case "ANTHROPIC" -> "https://api.anthropic.com/v1/messages";
            case "OLLAMA" -> "http://localhost:11434/v1/chat/completions";
            case "GEMINI" -> "https://generativelanguage.googleapis.com/v1beta";
            case "OPENAI_RESPONSES" -> "https://api.openai.com/v1/responses";
            case "SENSENOVA" -> "https://api.sensenova.cn/v1/chat/completions";
            default -> "https://api.openai.com/v1/chat/completions";
        };
    }

    private String defaultModelName(String providerType) {
        return switch (normalizeProviderType(providerType)) {
            case "ANTHROPIC" -> "claude-3-5-sonnet-latest";
            case "OLLAMA" -> "llama3.1";
            case "GEMINI" -> "gemini-1.5-pro";
            case "SENSENOVA" -> "SenseNova-6.7-Flash-Lite";
            default -> "gpt-4o-mini";
        };
    }

    private String normalizeCapabilities(String value) {
        if (!hasText(value)) {
            return "TEXT";
        }
        String upper = value.toUpperCase(Locale.ROOT);
        List<String> caps = new ArrayList<>();
        if (upper.contains("TEXT")) caps.add("TEXT");
        if (upper.contains("VISION")) caps.add("VISION");
        if (upper.contains("EMBED")) caps.add("EMBEDDING");
        if (upper.contains("WEB") || upper.contains("SEARCH") || upper.contains("联网")) caps.add("WEB_SEARCH");
        if (upper.contains("REASON") || upper.contains("THINK")) caps.add("REASONING");
        return caps.isEmpty() ? "TEXT" : String.join(",", caps);
    }

    private String stringValue(Object value) {
        if (value == null) {
            return null;
        }
        String text = value.toString().trim();
        return text.isBlank() ? null : text;
    }

    private String valueOr(Object value, String fallback) {
        String text = stringValue(value);
        return text == null ? fallback : text;
    }

    private boolean booleanValue(Object value, boolean fallback) {
        if (value == null) {
            return fallback;
        }
        if (value instanceof Boolean bool) {
            return bool;
        }
        return Boolean.parseBoolean(value.toString());
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

    private boolean hasText(String value) {
        return value != null && !value.trim().isEmpty();
    }

    private String limitText(String value, int maxLength) {
        if (value == null) {
            return "";
        }
        String text = value.replaceAll("\\s+", " ").trim();
        if (text.length() <= maxLength) {
            return text;
        }
        return text.substring(0, maxLength) + "...";
    }

    /** 从 AI 响应文本中提取 JSON 数组部分 */
    private String extractJsonArray(String text) {
        int start = text.indexOf('[');
        int end = text.lastIndexOf(']');
        if (start >= 0 && end > start) {
            return text.substring(start, end + 1);
        }
        throw new RuntimeException("未找到 JSON 数组");
    }

    private String extractJsonObject(String text) {
        int start = text.indexOf('{');
        int end = text.lastIndexOf('}');
        if (start >= 0 && end > start) {
            return text.substring(start, end + 1);
        }
        throw new RuntimeException("未找到 JSON 对象");
    }
}
