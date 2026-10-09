package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("shared_plan_task_template")
public class SharedPlanTaskTemplate {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long templateId;
    private String title;
    private String description;
    private Integer relativeStartDay;
    private Integer relativeDeadlineDay;
    private String preferredTime;
    private Integer durationMinutes;
    private String taskType;
    private Integer difficulty;
    private Integer quadrant;
    private Integer priority;
    private String reminderOffsets;
    private Integer sortOrder;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableLogic
    private Integer deleted;
}
