package com.zhiqu.service;

import com.zhiqu.entity.AiAgentTask;

public interface AgentTaskExecutor {
    AiAgentTask start(AiAgentTask task);

    void complete(AiAgentTask task, String publicSummary);

    void fail(AiAgentTask task, Exception error);
}
