package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("knowledge_operation_log")
public class KnowledgeOperationLog {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private String operationType;
    private Long pageId;
    private Long patchSetId;
    private Long sourceId;
    private String title;
    private String detail;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableLogic
    private Integer deleted;
}
