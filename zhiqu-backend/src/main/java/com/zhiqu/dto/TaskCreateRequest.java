package com.zhiqu.dto;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import lombok.Data;

import java.time.LocalDateTime;
import java.util.List;

@Data
public class TaskCreateRequest {
    @NotBlank(message = "任务标题不能为空")
    private String title;
    private String description;

    @NotNull(message = "象限不能为空")
    @Min(value = 1, message = "象限范围是1到4")
    @Max(value = 4, message = "象限范围是1到4")
    private Integer quadrant;

    @Min(value = 0, message = "优先级范围是0到3")
    @Max(value = 3, message = "优先级范围是0到3")
    private Integer priority;

    @Min(value = 0, message = "状态范围是0到2")
    @Max(value = 2, message = "状态范围是0到2")
    private Integer status;

    private LocalDateTime startTime;
    private Integer durationMinutes;
    /** 持续周数：> 1 时走展开创建（每周一条） */
    private Integer repeatWeeks;
    private String taskType;
    @Min(value = 1, message = "难度范围是1到5")
    @Max(value = 5, message = "难度范围是1到5")
    private Integer difficulty;
    private String aiReminderReason;
    private List<Integer> reminderOffsets;
    private LocalDateTime deadline;
    private LocalDateTime reminderTime;
}
