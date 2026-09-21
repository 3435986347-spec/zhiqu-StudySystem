package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("ai_source_chunk")
public class AiSourceChunk {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long sourceId;
    private Long knowledgeSourceId;
    private Integer chunkIndex;
    private String content;
    private String metadataJson;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
