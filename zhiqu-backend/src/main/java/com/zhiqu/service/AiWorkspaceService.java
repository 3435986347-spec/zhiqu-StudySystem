package com.zhiqu.service;

import com.zhiqu.entity.*;
import com.zhiqu.service.workspace.ArtifactFiles;
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

    /**
     * 读出这一轮挂在消息上的<b>图片</b>原件，供视觉模型直接看。
     *
     * <p>图片上传时只存原件、不做文本解析，所以它在检索里什么都不是；要被理解只能原样
     * 送进模型。读文件一律经 {@code PrivateUploadPathGuard} —— {@code file_path} 是库里的
     * 一个字符串，一次坏写入就能让它指向别人的目录，而那一行在归属上仍然合法。
     *
     * @param sourceIds 用户这一轮选中的资料 id；其中非图片、不属于本用户、文件已不在的一律跳过
     */
    List<com.zhiqu.service.ai.ChatImageAttachments.LoadedImage> loadAttachedImages(
            Long userId, Long notebookId, java.util.Collection<Long> sourceIds);

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
    // 第一百三十四轮：代码任务最多 10 分钟，整条回答留 15 分钟（前置检索、收尾、存档也占时间）。
    long STREAM_TIMEOUT_MS = 900_000L;

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

    /** 生成到产物：这一轮新增和改过的文件存库，挂在一个 GENERATED_FILES 产物上。一个文件都没有返回 null */
    AiAgentArtifact saveGeneratedFiles(Long runId, Long stepId, Long userId, Long conversationId,
                                       List<ArtifactFiles.Generated> files, Long sourceMessageId);

    /** 临时空间清掉了（几天没动）就从数据库恢复这段对话生成过的文件，接着聊时模型看得到 */
    void prepareArtifactSpace(Long userId, Long conversationId);

    /** 这段对话生成过的文件（每个路径最新的那一份）。notebookId 为空是普通聊天 */
    List<Map<String, Object>> generatedFiles(Long userId, Long notebookId);

    /** 取一个生成的文件：只有本人能取 */
    AiArtifactFile artifactFile(Long userId, Long artifactId, Long fileId);

    void completeRun(AiAgentRun run, AiMessage assistantMessage);

    void errorRun(AiAgentRun run, Exception error);

    /** 流式竞态重建消息对后，把 run 的两个消息外键与本 run 名下 artifact 的来源消息重绑到实际存活的行 */
    void rebindRunMessages(AiAgentRun run, AiMessage userMessage, AiMessage assistantMessage);

    /** Notebook 已删、迟到回答被丢弃：run 标记为 CANCELED（与 DONE/ERROR 区分，不再产出后续产物） */
    void cancelRun(AiAgentRun run, String reason);

    Map<String, Object> getRun(Long userId, Long runId);

    List<Map<String, Object>> listRuns(Long userId, Long notebookId);

    /**
     * 桌面应用本机跑完的一轮存回这条对话（第一百三十一轮）。文件不在服务器上写：
     * 草稿标 {@code desktop: true}，确认时外壳写进用户选过的文件夹。
     */
    Map<String, Object> archiveDesktopTurn(Long userId, Map<String, Object> body);

    Map<String, Object> confirmArtifact(Long userId, Long id, Map<String, Object> editedPlan);

    Map<String, Object> discardArtifact(Long userId, Long id);
}
