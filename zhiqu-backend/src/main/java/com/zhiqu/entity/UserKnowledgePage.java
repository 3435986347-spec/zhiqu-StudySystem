package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("user_knowledge_page")
public class UserKnowledgePage {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private Long parentId;
    private String pageType;
    private Integer sortOrder;
    private String title;
    private String encryptedContent;
    private String contentSummary;
    private Long sourceMessageId;
    private Long sourceConversationId;
    private Integer pinned;
    private LocalDateTime lastUsedAt;
    private String encryptionVersion;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
