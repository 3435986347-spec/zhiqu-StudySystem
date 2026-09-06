package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("ai_agent_task")
public class AiAgentTask {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long runId;
    private Long parentTaskId;
    private String agentType;
    private String taskType;
    private String status;
    private Integer priority;
    private String parallelGroupId;
    private String dependsOnJson;
    private String inputJson;
    private String outputJson;
    private String publicSummary;
    private String errorMessage;
    private LocalDateTime startedAt;
    private LocalDateTime completedAt;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
