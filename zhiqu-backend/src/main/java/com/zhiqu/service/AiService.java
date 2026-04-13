package com.zhiqu.service;

import com.zhiqu.entity.UserAiConfig;

import java.util.List;
import java.util.Map;

public interface AiService {
    /** 获取用户 AI 配置 */
    UserAiConfig getConfig(Long userId);

    /** 保存/更新用户 AI 配置 */
    void saveConfig(Long userId, String apiUrl, String apiKey, String modelName);

    /** 调用 AI 分析文件内容，返回结构化任务列表 */
    List<Map<String, Object>> analyzeContent(Long userId, String content, String fileName);

    /** 普通对话 */
    String chat(Long userId, String message);
}
