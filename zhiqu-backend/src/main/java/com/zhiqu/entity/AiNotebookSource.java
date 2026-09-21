package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("ai_notebook_source")
public class AiNotebookSource {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private Long notebookId;
    private Long knowledgeSourceId;
    private String sourceType;
    private String title;
    private String url;
    private String filePath;
    private String status;
    private String parseError;
    private String contentHash;
    private String indexStatus;
    private String indexVersion;
    private String indexError;
    private LocalDateTime indexedAt;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
