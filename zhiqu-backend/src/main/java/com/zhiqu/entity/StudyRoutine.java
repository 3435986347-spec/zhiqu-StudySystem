package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableLogic;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;

@Data
@TableName("study_routine")
public class StudyRoutine {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private String title;
    private String description;
    private String frequency;
    private String daysOfWeek;
    private LocalDate startDate;
    private LocalDate endDate;
    private LocalTime preferredTime;
    private Integer durationMinutes;
    private String taskType;
    private Integer difficulty;
    private Integer quadrant;
    private Integer priority;
    private Integer reminderEnabled;
    private String reminderOffsets;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
