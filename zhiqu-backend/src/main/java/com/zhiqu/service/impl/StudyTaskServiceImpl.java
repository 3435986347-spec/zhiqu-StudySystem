package com.zhiqu.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.dto.TaskCreateRequest;
import com.zhiqu.dto.TaskUpdateRequest;
import com.zhiqu.entity.StudyTask;
import com.zhiqu.mapper.StudyTaskMapper;
import com.zhiqu.service.AchievementService;
import com.zhiqu.service.StudyTaskService;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@Service
public class StudyTaskServiceImpl implements StudyTaskService {
    private final StudyTaskMapper studyTaskMapper;
    private final AchievementService achievementService;

    public StudyTaskServiceImpl(StudyTaskMapper studyTaskMapper, AchievementService achievementService) {
        this.studyTaskMapper = studyTaskMapper;
        this.achievementService = achievementService;
    }

    @Override
    public StudyTask create(Long userId, TaskCreateRequest request) {
        StudyTask task = new StudyTask();
        task.setUserId(userId);
        task.setTitle(request.getTitle());
        task.setDescription(request.getDescription());
        task.setQuadrant(request.getQuadrant());
        task.setPriority(request.getPriority() == null ? 0 : request.getPriority());
        task.setStatus(request.getStatus() == null ? 0 : request.getStatus());
        task.setDeadline(request.getDeadline());
        task.setReminderTime(request.getReminderTime());
        if (task.getStatus() == 2) {
            task.setCompletedAt(LocalDateTime.now());
        }
        studyTaskMapper.insert(task);
        return task;
    }

    @Override
    public StudyTask update(Long userId, Long taskId, TaskUpdateRequest request) {
        StudyTask task = findOwnedTask(userId, taskId);
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
        task.setDeadline(request.getDeadline());
        task.setReminderTime(request.getReminderTime());
        studyTaskMapper.updateById(task);
        return task;
    }

    @Override
    public void delete(Long userId, Long taskId) {
        StudyTask task = findOwnedTask(userId, taskId);
        studyTaskMapper.deleteById(task.getId());
    }

    @Override
    public StudyTask detail(Long userId, Long taskId) {
        return findOwnedTask(userId, taskId);
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
        return studyTaskMapper.selectList(wrapper);
    }

    @Override
    public Map<String, List<StudyTask>> quadrant(Long userId) {
        List<StudyTask> all = list(userId, null, null, null, null, null);
        return all.stream().collect(Collectors.groupingBy(t -> "q" + t.getQuadrant()));
    }

    @Override
    public StudyTask updateStatus(Long userId, Long taskId, Integer status) {
        if (status == null || status < 0 || status > 2) {
            throw new BusinessException("状态范围是0到2");
        }
        StudyTask task = findOwnedTask(userId, taskId);
        task.setStatus(status);
        task.setCompletedAt(status == 2 ? LocalDateTime.now() : null);
        studyTaskMapper.updateById(task);
        if (status == 2) {
            achievementService.checkAndUnlock(userId, "task_completed");
        }
        return task;
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
