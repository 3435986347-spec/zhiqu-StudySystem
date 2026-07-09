package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("ai_verifier_finding")
public class AiVerifierFinding {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long runId;
    private Long taskId;
    private String severity;
    private String code;
    private String message;
    private String targetType;
    private Long targetId;
    private String action;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
