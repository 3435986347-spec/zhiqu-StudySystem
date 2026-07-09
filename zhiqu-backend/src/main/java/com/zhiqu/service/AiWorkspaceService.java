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

    void deleteSource(Long userId, Long notebookId, Long sourceId);

    Map<String, Object> downloadSource(Long userId, Long notebookId, Long sourceId);

    AiNotebook ensureDefaultNotebook(Long userId);

    List<Map<String, Object>> listSources(Long userId, Long notebookId);

    Map<String, Object> createSource(Long userId, Long notebookId, Map<String, Object> body);

    Map<String, Object> uploadSource(Long userId, Long notebookId, MultipartFile file);

    List<Map<String, Object>> sourceContext(Long userId, Long notebookId, Map<String, Object> contextOptions);

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

    Map<String, Object> getRun(Long userId, Long runId);

    List<Map<String, Object>> listRuns(Long userId, Long notebookId);

    Map<String, Object> confirmArtifact(Long userId, Long id);

    Map<String, Object> discardArtifact(Long userId, Long id);
}
