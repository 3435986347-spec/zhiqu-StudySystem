package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("knowledge_page_link")
public class KnowledgePageLink {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private Long sourcePageId;
    private Long targetPageId;
    private String targetTitle;
    private String linkType;
    private String anchorText;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableLogic
    private Integer deleted;
}
