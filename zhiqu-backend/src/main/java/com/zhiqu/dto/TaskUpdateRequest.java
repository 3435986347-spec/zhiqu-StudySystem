package com.zhiqu.dto;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import lombok.Data;

import java.time.LocalDateTime;

@Data
public class TaskUpdateRequest {
    @NotBlank(message = "任务标题不能为空")
    private String title;
    private String description;

    @Min(value = 1, message = "象限范围是1到4")
    @Max(value = 4, message = "象限范围是1到4")
    private Integer quadrant;

    @Min(value = 0, message = "优先级范围是0到3")
    @Max(value = 3, message = "优先级范围是0到3")
    private Integer priority;

    @Min(value = 0, message = "状态范围是0到2")
    @Max(value = 2, message = "状态范围是0到2")
    private Integer status;

    private LocalDateTime deadline;
    private LocalDateTime reminderTime;
}
