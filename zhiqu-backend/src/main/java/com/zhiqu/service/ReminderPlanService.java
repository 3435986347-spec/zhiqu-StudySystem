package com.zhiqu.service;

import com.zhiqu.entity.StudyTask;
import com.zhiqu.entity.TaskReminder;

import java.util.List;

public interface ReminderPlanService {
    void refreshRemindersForTask(StudyTask task, List<Integer> reminderOffsets);

    void cancelPendingReminders(Long userId, Long taskId, String reason);

    List<Integer> suggestOffsets(String taskType, Integer difficulty);

    List<TaskReminder> listTaskReminders(Long userId, Long taskId);
}
