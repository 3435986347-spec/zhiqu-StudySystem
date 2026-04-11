package com.zhiqu.dto;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import lombok.Data;

import java.time.LocalDate;

@Data
public class StudyRecordCreateRequest {
    private Long taskId;

    @NotNull(message = "学习日期不能为空")
    private LocalDate studyDate;

    @NotNull(message = "学习时长不能为空")
    @Min(value = 1, message = "学习时长必须大于0分钟")
    private Integer durationMinutes;

    private String note;
}
