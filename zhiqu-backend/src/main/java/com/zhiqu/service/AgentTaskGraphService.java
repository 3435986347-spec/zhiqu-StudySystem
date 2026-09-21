package com.zhiqu.service;

import com.zhiqu.entity.AiAgentTask;

import java.util.List;
import java.util.Map;

public interface AgentTaskGraphService {
    AiAgentTask createTask(Long runId, Long parentTaskId, String agentType, String taskType,
                           int priority, String parallelGroupId, List<Long> dependsOn,
                           Map<String, Object> input, String publicSummary);

    AiAgentTask startTask(AiAgentTask task);

    void completeTask(AiAgentTask task, Map<String, Object> output, String publicSummary);

    AiAgentTask skipTask(Long runId, String agentType, String taskType, String publicSummary);

    void skipTask(AiAgentTask task, String publicSummary);

    void errorTask(AiAgentTask task, Exception error);

    List<AiAgentTask> listTasks(Long runId);

    List<Map<String, Object>> listTaskRows(Long runId);
}
