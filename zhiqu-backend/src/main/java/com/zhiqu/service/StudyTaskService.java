package com.zhiqu.service;

import com.zhiqu.dto.TaskCreateRequest;
import com.zhiqu.dto.TaskUpdateRequest;
import com.zhiqu.entity.StudyTask;

import java.util.List;
import java.util.Map;

public interface StudyTaskService {
    StudyTask create(Long userId, TaskCreateRequest request);

    StudyTask update(Long userId, Long taskId, TaskUpdateRequest request);

    void delete(Long userId, Long taskId);

    StudyTask detail(Long userId, Long taskId);

    List<StudyTask> list(Long userId, Integer quadrant, Integer status, Integer priority, String sortBy, String sortOrder);

    Map<String, List<StudyTask>> quadrant(Long userId);

    StudyTask updateStatus(Long userId, Long taskId, Integer status);
}
