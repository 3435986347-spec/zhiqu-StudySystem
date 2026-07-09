package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("ai_agent_artifact")
public class AiAgentArtifact {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long runId;
    private Long stepId;
    private String artifactType;
    private String title;
    private String contentJson;
    private String status;
    private String targetType;
    private Long targetId;
    private Long sourceMessageId;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
