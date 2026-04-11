package com.zhiqu.dto;

import lombok.Builder;
import lombok.Data;

import java.util.Map;

@Data
@Builder
public class StudyStatisticsVO {
    private Integer consecutiveDays;
    private Integer totalStudyMinutes;
    private Long completedTaskCount;
    private Long totalTaskCount;
    private Map<Integer, Long> quadrantDistribution;
}
