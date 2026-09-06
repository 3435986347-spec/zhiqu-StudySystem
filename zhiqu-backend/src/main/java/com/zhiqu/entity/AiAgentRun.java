package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("ai_agent_run")
public class AiAgentRun {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private Long userMessageId;
    private Long assistantMessageId;
    private Long notebookId;
    private String status;
    private String agentMode;
    private String contextOptionsJson;
    private String executionMode;
    private Integer maxSteps;
    private Integer maxParallelTasks;
    private Integer maxTokens;
    private Integer timeoutSeconds;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    private LocalDateTime completedAt;
    private String errorMessage;
}
