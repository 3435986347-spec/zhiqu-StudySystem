package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("knowledge_source")
public class KnowledgeSource {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private String sourceType;
    private String title;
    private String sourceRef;
    private String encryptedContent;
    private String contentSummary;
    private Long conversationId;
    private Long messageId;
    private String immutableHash;
    private String encryptionVersion;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableLogic
    private Integer deleted;
}
