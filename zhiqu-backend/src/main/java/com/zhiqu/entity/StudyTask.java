package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("study_task")
public class StudyTask {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private String title;
    private String encryptedTitle;
    private String description;
    private String encryptedDescription;
    private String encryptionVersion;
    private Integer quadrant;
    private Integer priority;
    private Integer status;
    private LocalDateTime startTime;
    private Integer durationMinutes;
    private Integer repeatWeeks;
    private String repeatGroupId;
    private Integer repeatWeekNumber;
    private String taskType;
    private Integer difficulty;
    private String aiReminderReason;
    private LocalDateTime deadline;
    private LocalDateTime reminderTime;
    private LocalDateTime completedAt;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @Version
    private Integer version;

    @TableLogic
    private Integer deleted;
}
