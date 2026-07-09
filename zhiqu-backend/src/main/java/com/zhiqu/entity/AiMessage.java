package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("ai_message")
public class AiMessage {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private Long conversationId;
    private Long agentRunId;
    private String role;
    private String content;
    private String status;
    private String requestId;
    private String providerType;
    private String modelName;
    private String reasoningSummary;
    private String citationsJson;
    private String retrievalStatusJson;
    private String usageJson;
    private String reasoningMode;
    private Boolean webSearchEnabled;
    private LocalDateTime completedAt;
    private String errorMessage;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableLogic
    private Integer deleted;
}
