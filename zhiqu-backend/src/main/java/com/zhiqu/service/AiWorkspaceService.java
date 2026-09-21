package com.zhiqu.service;

import com.zhiqu.entity.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;
import java.util.Map;

public interface AiWorkspaceService {
    List<Map<String, Object>> listNotebooks(Long userId);

    Map<String, Object> createNotebook(Long userId, Map<String, Object> body);

    Map<String, Object> updateNotebook(Long userId, Long id, Map<String, Object> body);

    void deleteNotebook(Long userId, Long id);

    /** 校验 notebook 存在且属于当前用户（含未软删），不满足时抛业务异常；供会话读写入口统一复用 */
    AiNotebook requireOwnedNotebook(Long userId, Long id);

    void deleteSource(Long userId, Long notebookId, Long sourceId);

    Map<String, Object> downloadSource(Long userId, Long notebookId, Long sourceId);

    AiNotebook ensureDefaultNotebook(Long userId);

    List<Map<String, Object>> listSources(Long userId, Long notebookId);

    Map<String, Object> createSource(Long userId, Long notebookId, Map<String, Object> body);

    Map<String, Object> uploadSource(Long userId, Long notebookId, MultipartFile file);

    List<Map<String, Object>> sourceContext(Long userId, Long notebookId, Map<String, Object> contextOptions);

    /**
     * 一轮流式对话的总超时 —— <b>SSE emitter 与 {@code ai_agent_run.timeout_seconds} 的唯一来源</b>。
     *
     * <p>此前 emitter 写死 300_000L，而 run 上记的是 120 —— 两个独立的数，而且记下来的那个是错的。
     * 按 120 去做任何护栏都会砍掉合法的慢轮次：一轮可能串起 wiki 工具循环（30s 预算）、
     * 流式回答（读超时 60s）、以及 POST_STREAM 那组并发调用。
     */
    long STREAM_TIMEOUT_MS = 300_000L;

    /** 建完图之后按真实形态订正 execution_mode（beginRun 时图还没建）。 */
    void markExecutionMode(AiAgentRun run, boolean parallel);

    AiAgentRun beginRun(Long userId, Long notebookId, String agentMode, Map<String, Object> contextOptions,
                        AiMessage userMessage, AiMessage assistantMessage);

    AiAgentStep startStep(Long runId, String agentType, int order, String publicSummary);

    AiAgentStep startStep(Long runId, Long taskId, String agentType, int order, String publicSummary);

    void completeStep(AiAgentStep step, String publicSummary, String outputSummary);

    void skipStep(Long runId, String agentType, int order, String publicSummary);

    void skipStep(Long runId, Long taskId, String agentType, int order, String publicSummary);

    void errorStep(AiAgentStep step, Exception error);

    AiAgentArtifact createArtifact(Long runId, Long stepId, String artifactType, String title,
                                   Map<String, Object> content, Long sourceMessageId);

    void completeRun(AiAgentRun run, AiMessage assistantMessage);

    void errorRun(AiAgentRun run, Exception error);

    /** 流式竞态重建消息对后，把 run 的两个消息外键与本 run 名下 artifact 的来源消息重绑到实际存活的行 */
    void rebindRunMessages(AiAgentRun run, AiMessage userMessage, AiMessage assistantMessage);

    /** Notebook 已删、迟到回答被丢弃：run 标记为 CANCELED（与 DONE/ERROR 区分，不再产出后续产物） */
    void cancelRun(AiAgentRun run, String reason);

    Map<String, Object> getRun(Long userId, Long runId);

    List<Map<String, Object>> listRuns(Long userId, Long notebookId);

    Map<String, Object> confirmArtifact(Long userId, Long id, Map<String, Object> editedPlan);

    Map<String, Object> discardArtifact(Long userId, Long id);
}
