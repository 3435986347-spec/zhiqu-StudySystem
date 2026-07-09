package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("ai_agent_step")
public class AiAgentStep {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long runId;
    private Long taskId;
    private String agentType;
    private Integer stepOrder;
    private String parallelGroupId;
    private Integer attemptNo;
    private String status;
    private String publicSummary;
    private String inputSummary;
    private String outputSummary;
    private String errorMessage;
    private LocalDateTime startedAt;
    private LocalDateTime completedAt;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
