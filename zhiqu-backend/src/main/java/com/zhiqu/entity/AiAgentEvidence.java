package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("ai_agent_evidence")
public class AiAgentEvidence {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long runId;
    private Long taskId;
    private Long stepId;
    private String sourceType;
    private String sourceId;
    private Long artifactId;
    private String snippet;
    private String metadataJson;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
