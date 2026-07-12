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
    /** 草稿生成时目标页正文的哈希；合入前比对当前页哈希，检测“草稿生成后原页已被改动”的冲突。为空表示无基准（老数据/新建页）。 */
    private String baseContentHash;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    private LocalDateTime appliedAt;

    @TableLogic
    private Integer deleted;
}
