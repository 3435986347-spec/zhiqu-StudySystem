package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("user_knowledge_revision")
public class UserKnowledgeRevision {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private Long patchSetId;
    private Long pageId;
    private String actionType;
    private String title;
    private String encryptedContent;
    private String status;
    private Long sourceMessageId;
    private Long sourceConversationId;
    private String encryptionVersion;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    private LocalDateTime appliedAt;

    @TableLogic
    private Integer deleted;
}
