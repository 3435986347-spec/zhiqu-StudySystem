package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("knowledge_patch_set")
public class KnowledgePatchSet {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private String title;
    private String summary;
    private String status;
    private String triggerType;
    private Long sourceConversationId;
    private Long sourceMessageId;
    private LocalDateTime appliedAt;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
