package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDateTime;

@Data
@TableName("ai_agent_claim")
public class AiAgentClaim {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long runId;
    private Long stepId;
    private Long taskId;
    private String claimType;
    private String content;
    private BigDecimal confidence;
    private String evidenceIdsJson;
    private String metadataJson;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
