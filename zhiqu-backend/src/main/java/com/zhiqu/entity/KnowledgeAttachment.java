package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

/** Private vault attachment, independent from parsed Raw Sources. */
@Data
@TableName("knowledge_attachment")
public class KnowledgeAttachment {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private String name;
    private String kind;
    private String originalPath;
    private String mimeType;
    private Long byteSize;
    private Integer width;
    private Integer height;
    private String encryptedData;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableLogic
    private Integer deleted;
}
