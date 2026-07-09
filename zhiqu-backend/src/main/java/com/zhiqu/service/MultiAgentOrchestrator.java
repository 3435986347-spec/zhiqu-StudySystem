package com.zhiqu.service;

import com.zhiqu.entity.AiAgentRun;
import com.zhiqu.entity.AiAgentTask;

import java.util.List;
import java.util.Map;

public interface MultiAgentOrchestrator {
    List<AiAgentTask> plan(AiAgentRun run, String message, String agentMode,
                           boolean enableWebSearch, Long notebookId, Map<String, Object> contextOptions);
}
