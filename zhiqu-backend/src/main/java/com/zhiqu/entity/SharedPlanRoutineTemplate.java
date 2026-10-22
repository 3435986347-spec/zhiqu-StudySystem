package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("shared_plan_routine_template")
public class SharedPlanRoutineTemplate {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long templateId;
    private String title;
    private String description;
    private String frequency;
    private String daysOfWeek;
    private Integer relativeStartDay;
    private Integer relativeEndDay;
    private String preferredTime;
    private Integer durationMinutes;
    private String taskType;
    private Integer difficulty;
    private Integer quadrant;
    private Integer priority;
    private Integer reminderEnabled;
    private String reminderOffsets;
    private Integer sortOrder;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableLogic
    private Integer deleted;
}
