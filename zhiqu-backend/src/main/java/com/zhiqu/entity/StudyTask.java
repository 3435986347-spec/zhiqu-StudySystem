package com.zhiqu.entity;

import com.baomidou.mybatisplus.annotation.*;
import com.fasterxml.jackson.annotation.JsonIgnore;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("study_task")
public class StudyTask {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private String title;
    /*
     * 密文与加密版本只在库里用，不进接口回包。原来任务列表里每条都带着明文标题、密文标题、明文描述、密文描述 ——
     * 页面从不读密文，回包白白多出一倍的文字；一个页面拿全部任务时这就是实打实的体积（也没理由把密文递出去）。
     */
    @JsonIgnore
    private String encryptedTitle;
    private String description;
    @JsonIgnore
    private String encryptedDescription;
    @JsonIgnore
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
