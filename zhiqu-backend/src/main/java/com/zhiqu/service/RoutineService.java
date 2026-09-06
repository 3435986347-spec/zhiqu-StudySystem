package com.zhiqu.service;

import com.zhiqu.entity.StudyRoutine;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;

public interface RoutineService {
    StudyRoutine create(Long userId, Map<String, Object> body);

    List<StudyRoutine> createBatch(Long userId, List<Map<String, Object>> routines);

    List<Map<String, Object>> list(Long userId);

    List<Map<String, Object>> instances(Long userId, LocalDate from, LocalDate to);

    Map<String, Object> checkin(Long userId, Long routineId, Map<String, Object> body);

    void delete(Long userId, Long routineId);

    List<Map<String, Object>> reminderInstances(LocalDate date);
}
