package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("shared_plan_template")
public class SharedPlanTemplate {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private String title;
    private String description;
    private String category;
    private String targetAudience;
    private String status;
    private Integer anonymized;
    private Long reviewedBy;
    private LocalDateTime reviewedAt;
    private String rejectionReason;
    private Integer applyCount;
    private Integer likeCount;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
