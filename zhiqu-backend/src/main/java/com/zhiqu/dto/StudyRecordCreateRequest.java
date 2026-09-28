package com.zhiqu.dto;

import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import lombok.Data;

import java.time.LocalDate;

@Data
public class StudyRecordCreateRequest {
    private Long taskId;

    /** 不给就是服务端的「今天」（第二十一轮：番茄钟不再自己算日期 —— 浏览器的钟在一次专注里走快了，算出来的「明天」会被拒、这条记录就丢了）。 */
    private LocalDate studyDate;

    @NotNull(message = "学习时长不能为空")
    @Min(value = 1, message = "学习时长必须大于0分钟")
    private Integer durationMinutes;

    private String note;
}
