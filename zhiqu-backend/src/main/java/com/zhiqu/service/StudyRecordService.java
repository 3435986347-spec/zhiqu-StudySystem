package com.zhiqu.service;

import com.zhiqu.dto.StudyRecordCreateRequest;
import com.zhiqu.dto.StudyStatisticsVO;
import com.zhiqu.entity.StudyRecord;

import java.util.List;
import java.util.Map;

public interface StudyRecordService {
    StudyRecord create(Long userId, StudyRecordCreateRequest request);

    List<StudyRecord> list(Long userId);

    StudyStatisticsVO statistics(Long userId);

    List<Map<String, Object>> trend(Long userId, String type);
}
