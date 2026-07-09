package com.zhiqu.service;

import com.zhiqu.entity.UserAiConfig;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.List;
import java.util.Map;

public interface AiService {
    /** 获取用户 AI 配置 */
    UserAiConfig getConfig(Long userId);

    /** 保存/更新用户 AI 配置 */
    void saveConfig(Long userId, String apiUrl, String apiKey, String modelName);

    /** 调用 AI 分析文本文件内容，返回结构化任务列表 */
    List<Map<String, Object>> analyzeContent(Long userId, String content, String fileName);

    /** 调用 AI 分析图片内容（Base64），返回结构化任务列表 */
    List<Map<String, Object>> analyzeImage(Long userId, String base64Image, String mediaType, String fileName);

    /** 普通对话 */
    Map<String, Object> chat(Long userId, String message);

    /** 指定模型普通对话 */
    Map<String, Object> chat(Long userId, String message, Long modelConfigId);

    Map<String, Object> chat(Long userId, String message, Long modelConfigId,
                             Boolean enableWebSearch, String reasoningMode);

    SseEmitter streamChat(Long userId, String message, Long modelConfigId,
                          Boolean enableWebSearch, String reasoningMode);

    SseEmitter streamChat(Long userId, String message, Long modelConfigId,
                          Boolean enableWebSearch, String reasoningMode,
                          Long notebookId, String agentMode, Map<String, Object> contextOptions);

    /** 模型列表，包含系统模型和个人模型 */
    Map<String, Object> listModels(Long userId);

    /** 新增或更新个人模型 */
    Map<String, Object> saveModel(Long userId, Long id, Map<String, Object> body);

    /** 删除个人模型 */
    void deleteModel(Long userId, Long id);

    /** 测试模型连通性 */
    Map<String, Object> testModel(Long userId, Long id);

    Map<String, Object> probeModel(Long userId, Long id);

    /** 获取长期记忆与最近对话摘要 */
    Map<String, Object> getMemory(Long userId);

    /** 获取最近聊天记录 */
    List<Map<String, Object>> getRecentChatMessages(Long userId, int limit);

    /** 删除单条聊天消息 */
    void deleteChatMessage(Long userId, Long messageId);

    /** 手动保存长期记忆 */
    void saveMemory(Long userId, String memoryText);

    /** 清空长期记忆和短期对话历史 */
    void clearMemory(Long userId);
}
