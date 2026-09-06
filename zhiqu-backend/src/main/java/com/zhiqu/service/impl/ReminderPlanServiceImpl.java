package com.zhiqu.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.entity.StudyTask;
import com.zhiqu.entity.TaskReminder;
import com.zhiqu.mapper.TaskReminderMapper;
import com.zhiqu.service.ReminderPlanService;
import com.zhiqu.service.concurrency.DeadlockRetry;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

@Service
public class ReminderPlanServiceImpl implements ReminderPlanService {
    private static final String STATUS_PENDING = "PENDING";
    private static final String STATUS_SKIPPED = "SKIPPED";
    private static final String TYPE_AUTO = "AUTO";
    private static final String TYPE_CUSTOM = "CUSTOM";

    private final TaskReminderMapper taskReminderMapper;

    public ReminderPlanServiceImpl(TaskReminderMapper taskReminderMapper) {
        this.taskReminderMapper = taskReminderMapper;
    }

    @Override
    @Transactional
    @DeadlockRetry
    public void refreshRemindersForTask(StudyTask task, List<Integer> reminderOffsets) {
        if (task == null || task.getId() == null || task.getUserId() == null) {
            return;
        }
        cancelPendingReminders(task.getUserId(), task.getId(), "任务提醒计划已重新生成");
        if (task.getStatus() != null && task.getStatus() == 2) {
            return;
        }

        LocalDateTime now = LocalDateTime.now();
        if (task.getDeadline() != null) {
            for (Integer offset : resolveOffsets(task, reminderOffsets)) {
                LocalDateTime scheduledAt = task.getDeadline()
                        .toLocalDate()
                        .minusDays(offset)
                        .atTime(LocalTime.of(8, 0));
                if (!scheduledAt.isAfter(now)) {
                    continue;
                }
                TaskReminder reminder = baseReminder(task);
                reminder.setOffsetDays(offset);
                reminder.setReminderType(TYPE_AUTO);
                reminder.setScheduledAt(scheduledAt);
                reminder.setStatus(STATUS_PENDING);
                taskReminderMapper.insert(reminder);
            }
        }

        if (task.getReminderTime() != null && task.getReminderTime().isAfter(now)) {
            TaskReminder custom = baseReminder(task);
            custom.setReminderType(TYPE_CUSTOM);
            custom.setScheduledAt(task.getReminderTime());
            custom.setStatus(STATUS_PENDING);
            taskReminderMapper.insert(custom);
        }
    }

    @Override
    @Transactional
    @DeadlockRetry
    public void cancelPendingReminders(Long userId, Long taskId, String reason) {
        List<TaskReminder> reminders = taskReminderMapper.selectList(new LambdaQueryWrapper<TaskReminder>()
                .eq(TaskReminder::getUserId, userId)
                .eq(TaskReminder::getTaskId, taskId)
                .eq(TaskReminder::getStatus, STATUS_PENDING));
        for (TaskReminder reminder : reminders) {
            reminder.setStatus(STATUS_SKIPPED);
            reminder.setFailureReason(limit(reason));
            taskReminderMapper.updateById(reminder);
        }
    }

    @Override
    public List<Integer> suggestOffsets(String taskType, Integer difficulty) {
        int level = difficulty == null ? 3 : Math.max(1, Math.min(5, difficulty));
        String type = taskType == null ? "" : taskType.toLowerCase(Locale.ROOT);
        boolean hardType = type.contains("exam")
                || type.contains("test")
                || type.contains("report")
                || type.contains("presentation")
                || type.contains("考试")
                || type.contains("测验")
                || type.contains("报告")
                || type.contains("论文")
                || type.contains("展示")
                || type.contains("答辩");
        if (hardType || level >= 4) {
            return List.of(14, 7, 4, 2, 1);
        }
        if (level <= 2) {
            return List.of(4, 2, 1);
        }
        return List.of(7, 4, 2);
    }

    @Override
    public List<TaskReminder> listTaskReminders(Long userId, Long taskId) {
        return taskReminderMapper.selectList(new LambdaQueryWrapper<TaskReminder>()
                .eq(TaskReminder::getUserId, userId)
                .eq(TaskReminder::getTaskId, taskId)
                .orderByAsc(TaskReminder::getScheduledAt));
    }

    private List<Integer> resolveOffsets(StudyTask task, List<Integer> requested) {
        List<Integer> source = requested == null ? suggestOffsets(task.getTaskType(), task.getDifficulty()) : requested;
        Set<Integer> clean = new LinkedHashSet<>();
        for (Integer offset : source) {
            if (offset == null) {
                continue;
            }
            int normalized = Math.max(0, Math.min(365, offset));
            clean.add(normalized);
        }
        List<Integer> result = new ArrayList<>(clean);
        result.sort(Comparator.reverseOrder());
        return result;
    }

    private TaskReminder baseReminder(StudyTask task) {
        TaskReminder reminder = new TaskReminder();
        reminder.setUserId(task.getUserId());
        reminder.setTaskId(task.getId());
        return reminder;
    }

    private String limit(String text) {
        if (text == null) {
            return null;
        }
        return text.length() > 480 ? text.substring(0, 480) : text;
    }
}
