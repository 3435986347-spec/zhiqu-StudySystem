package com.zhiqu.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.dto.TaskCreateRequest;
import com.zhiqu.dto.TaskUpdateRequest;
import com.zhiqu.entity.StudyTask;
import com.zhiqu.mapper.StudyTaskMapper;
import com.zhiqu.service.AchievementService;
import com.zhiqu.service.ReminderPlanService;
import com.zhiqu.service.StudyTaskService;
import com.zhiqu.service.concurrency.DeadlockRetry;
import com.zhiqu.service.privacy.TaskPrivacyService;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

@Service
public class StudyTaskServiceImpl implements StudyTaskService {
    private final StudyTaskMapper studyTaskMapper;
    private final AchievementService achievementService;
    private final ReminderPlanService reminderPlanService;
    private final TaskPrivacyService taskPrivacyService;

    public StudyTaskServiceImpl(StudyTaskMapper studyTaskMapper,
                                AchievementService achievementService,
                                ReminderPlanService reminderPlanService,
                                TaskPrivacyService taskPrivacyService) {
        this.studyTaskMapper = studyTaskMapper;
        this.achievementService = achievementService;
        this.reminderPlanService = reminderPlanService;
        this.taskPrivacyService = taskPrivacyService;
    }

    @Override
    @Transactional
    @DeadlockRetry
    public StudyTask create(Long userId, TaskCreateRequest request) {
        StudyTask task = new StudyTask();
        task.setUserId(userId);
        task.setTitle(request.getTitle());
        task.setDescription(request.getDescription());
        task.setQuadrant(request.getQuadrant());
        task.setPriority(request.getPriority() == null ? 0 : request.getPriority());
        task.setStatus(request.getStatus() == null ? 0 : request.getStatus());
        task.setStartTime(request.getStartTime());
        task.setDurationMinutes(request.getDurationMinutes());
        task.setTaskType(request.getTaskType());
        task.setDifficulty(request.getDifficulty());
        task.setAiReminderReason(request.getAiReminderReason());
        task.setDeadline(request.getDeadline());
        task.setReminderTime(request.getReminderTime());
        if (task.getStatus() == 2) {
            task.setCompletedAt(LocalDateTime.now());
        }
        taskPrivacyService.protectForWrite(task);
        studyTaskMapper.insert(task);
        reminderPlanService.refreshRemindersForTask(task, request.getReminderOffsets());
        achievementService.checkAndUnlock(userId, "task_created");
        return taskPrivacyService.reveal(task);
    }

    @Override
    @Transactional
    @DeadlockRetry
    public List<StudyTask> createRepeated(Long userId, TaskCreateRequest request) {
        Integer weeks = request.getRepeatWeeks();
        if (weeks == null || weeks < 1) {
            throw new BusinessException("持续周数必须大于 0");
        }
        if (request.getStartTime() == null) {
            throw new BusinessException("设置周期重复需要填写开始时间");
        }
        String groupId = weeks > 1 ? UUID.randomUUID().toString() : null;
        LocalDateTime baseStart = request.getStartTime();
        LocalDateTime baseDeadline = request.getDeadline();
        LocalDateTime baseReminderTime = request.getReminderTime();
        List<StudyTask> created = new ArrayList<>();

        for (int i = 0; i < weeks; i++) {
            StudyTask task = new StudyTask();
            task.setUserId(userId);
            task.setTitle(request.getTitle());
            task.setDescription(request.getDescription());
            task.setQuadrant(request.getQuadrant());
            task.setPriority(request.getPriority() == null ? 0 : request.getPriority());
            task.setStatus(request.getStatus() == null ? 0 : request.getStatus());
            task.setDurationMinutes(request.getDurationMinutes());
            task.setTaskType(request.getTaskType());
            task.setDifficulty(request.getDifficulty());
            task.setAiReminderReason(request.getAiReminderReason());
            if (baseReminderTime != null) {
                task.setReminderTime(baseReminderTime.plusWeeks(i));
            }
            task.setStartTime(baseStart.plusWeeks(i));
            if (baseDeadline != null) {
                task.setDeadline(baseDeadline.plusWeeks(i));
            }
            task.setRepeatWeeks(weeks);
            task.setRepeatGroupId(groupId);
            task.setRepeatWeekNumber(i + 1);
            if (task.getStatus() == 2) {
                task.setCompletedAt(LocalDateTime.now());
            }
            taskPrivacyService.protectForWrite(task);
            studyTaskMapper.insert(task);
            reminderPlanService.refreshRemindersForTask(task, request.getReminderOffsets());
            created.add(task);
        }
        achievementService.checkAndUnlock(userId, "task_created");
        return taskPrivacyService.revealAll(created);
    }

    @Override
    @Transactional
    @DeadlockRetry
    public StudyTask update(Long userId, Long taskId, TaskUpdateRequest request) {
        if (request.getVersion() == null) {
            throw new BusinessException("缺少任务版本号，请刷新后再编辑");
        }
        StudyTask task = findOwnedTask(userId, taskId);
        task.setVersion(request.getVersion());
        task.setTitle(request.getTitle());
        task.setDescription(request.getDescription());
        if (request.getQuadrant() != null) {
            task.setQuadrant(request.getQuadrant());
        }
        if (request.getPriority() != null) {
            task.setPriority(request.getPriority());
        }
        if (request.getStatus() != null) {
            task.setStatus(request.getStatus());
            task.setCompletedAt(request.getStatus() == 2 ? LocalDateTime.now() : null);
        }
        task.setStartTime(request.getStartTime());
        task.setDurationMinutes(request.getDurationMinutes());
        task.setTaskType(request.getTaskType());
        task.setDifficulty(request.getDifficulty());
        task.setAiReminderReason(request.getAiReminderReason());
        task.setDeadline(request.getDeadline());
        task.setReminderTime(request.getReminderTime());
        taskPrivacyService.protectForWrite(task);
        int updated = studyTaskMapper.updateById(task);
        if (updated == 0) {
            throw new BusinessException("任务已被其他页面修改，请刷新后再编辑");
        }
        reminderPlanService.refreshRemindersForTask(task, request.getReminderOffsets());
        task = findOwnedTask(userId, taskId);
        return taskPrivacyService.reveal(task);
    }

    @Override
    @Transactional
    @DeadlockRetry
    public void delete(Long userId, Long taskId) {
        StudyTask task = findOwnedTask(userId, taskId);
        studyTaskMapper.deleteById(task.getId());
    }

    @Override
    public StudyTask detail(Long userId, Long taskId) {
        return taskPrivacyService.reveal(findOwnedTask(userId, taskId));
    }

    @Override
    public List<StudyTask> list(Long userId, Integer quadrant, Integer status, Integer priority, String sortBy, String sortOrder) {
        LambdaQueryWrapper<StudyTask> wrapper = new LambdaQueryWrapper<StudyTask>()
                .eq(StudyTask::getUserId, userId);
        if (quadrant != null) {
            wrapper.eq(StudyTask::getQuadrant, quadrant);
        }
        if (status != null) {
            wrapper.eq(StudyTask::getStatus, status);
        }
        if (priority != null) {
            wrapper.eq(StudyTask::getPriority, priority);
        }

        boolean asc = "asc".equalsIgnoreCase(sortOrder);
        if ("deadline".equalsIgnoreCase(sortBy)) {
            wrapper.orderBy(true, asc, StudyTask::getDeadline);
        } else if ("priority".equalsIgnoreCase(sortBy)) {
            wrapper.orderBy(true, asc, StudyTask::getPriority);
        } else if ("updatedAt".equalsIgnoreCase(sortBy)) {
            wrapper.orderBy(true, asc, StudyTask::getUpdatedAt);
        } else {
            wrapper.orderByDesc(StudyTask::getUpdatedAt);
        }
        return taskPrivacyService.revealAll(studyTaskMapper.selectList(wrapper));
    }

    @Override
    public Map<String, List<StudyTask>> quadrant(Long userId) {
        List<StudyTask> all = list(userId, null, null, null, null, null);
        return all.stream().collect(Collectors.groupingBy(t -> "q" + t.getQuadrant()));
    }

    @Override
    @Transactional
    @DeadlockRetry
    public StudyTask updateStatus(Long userId, Long taskId, Integer status) {
        if (status == null || status < 0 || status > 2) {
            throw new BusinessException("状态范围是0到2");
        }
        StudyTask task = findOwnedTask(userId, taskId);
        task.setStatus(status);
        task.setCompletedAt(status == 2 ? LocalDateTime.now() : null);
        int updated = studyTaskMapper.updateById(task);
        if (updated == 0) {
            throw new BusinessException("任务状态更新失败，请刷新后重试");
        }
        if (status == 2) {
            reminderPlanService.cancelPendingReminders(userId, taskId, "任务已完成");
            achievementService.checkAndUnlock(userId, "task_completed");
        }
        return taskPrivacyService.reveal(findOwnedTask(userId, taskId));
    }

    private StudyTask findOwnedTask(Long userId, Long taskId) {
        StudyTask task = studyTaskMapper.selectOne(new LambdaQueryWrapper<StudyTask>()
                .eq(StudyTask::getId, taskId)
                .eq(StudyTask::getUserId, userId));
        if (task == null) {
            throw new BusinessException("任务不存在或无权访问");
        }
        return task;
    }
}
