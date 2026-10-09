package com.zhiqu.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

@Service
public class StudyTaskServiceImpl implements StudyTaskService {
    /**
     * 周期任务最多重复多少周。原来没有上限：每一周一条任务、外加它的几条提醒，全在一个事务里 ——
     * 一个 repeatWeeks = 1000000 的请求（或者 AI 草稿里模型随口写的 520）就是几百万行写入。
     * 判定在这里（而不是只在请求 DTO 上）：AI 草稿确认、参考计划套用都不经过 @Valid。
     */
    static final int MAX_REPEAT_WEEKS = 52;
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
        if (weeks > MAX_REPEAT_WEEKS) {
            throw new BusinessException("持续周数最多 " + MAX_REPEAT_WEEKS + " 周（一年）");
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
        return taskPrivacyService.revealAll(studyTaskMapper.selectList(listQuery(userId, quadrant, status, priority, sortBy, sortOrder)));
    }

    /** 一页最多这么多条 */
    static final int MAX_PAGE_SIZE = 500;

    /**
     * 分页（第十七轮）。用了两年的账号有几千条任务：任务页原来一次取回全部（1.6MB）、画出四万多个节点；
     * 例行计划页「从任务生成」只显示 20 条，也先取回全部。现在只取这一页、只解密这一页的标题。
     * 排序另按 id 兜底：只按 updatedAt 排的话，同一时刻改的几条在两页之间的先后不确定，会重复或漏掉。
     */
    @Override
    public Map<String, Object> page(Long userId, Integer quadrant, Integer status, Integer priority, String sortBy, String sortOrder,
                                    int offset, int limit) {
        return page(userId, quadrant, status, priority, sortBy, sortOrder, null, offset, limit);
    }

    /** 按关键词找时最多看多少条（第五十二轮）：用了两年的账号几千条，解一遍几十毫秒 */
    public static final int SEARCH_SCAN_MAX = 5000;

    @Override
    public Map<String, Object> page(Long userId, Integer quadrant, Integer status, Integer priority, String sortBy, String sortOrder,
                                    String keyword, int offset, int limit) {
        int size = Math.max(1, Math.min(MAX_PAGE_SIZE, limit));
        int from = Math.max(0, offset);
        String needle = keyword == null ? "" : keyword.strip().toLowerCase(Locale.ROOT);
        Map<String, Object> result = new LinkedHashMap<>();
        if (needle.isEmpty()) {
            long total = studyTaskMapper.selectCount(filterQuery(userId, quadrant, status, priority));
            LambdaQueryWrapper<StudyTask> query = listQuery(userId, quadrant, status, priority, sortBy, sortOrder)
                    .orderByDesc(StudyTask::getId)
                    .last("LIMIT " + size + " OFFSET " + from);
            result.put("items", taskPrivacyService.revealAll(studyTaskMapper.selectList(query)));
            result.put("total", total);
        } else {
            // 标题和说明是加密存的（数据库里 LIKE 不了）：按同样的筛选和顺序取出来、解开之后在这里找，再分页。
            // 多取一条看是不是超过了上限：超过了只在前 SEARCH_SCAN_MAX 条里找，并且告诉页面（不然「没找到」可能是假的）
            List<StudyTask> scanned = taskPrivacyService.revealAll(studyTaskMapper.selectList(
                    listQuery(userId, quadrant, status, priority, sortBy, sortOrder)
                            .orderByDesc(StudyTask::getId)
                            .last("LIMIT " + (SEARCH_SCAN_MAX + 1))));
            boolean capped = scanned.size() > SEARCH_SCAN_MAX;
            List<StudyTask> hits = scanned.stream().limit(SEARCH_SCAN_MAX)
                    .filter(t -> contains(t.getTitle(), needle) || contains(t.getDescription(), needle))
                    .collect(Collectors.toList());
            result.put("items", from >= hits.size() ? List.of() : new ArrayList<>(hits.subList(from, Math.min(hits.size(), from + size))));
            result.put("total", (long) hits.size());
            result.put("searchCapped", capped);
            result.put("searchLimit", SEARCH_SCAN_MAX);   // 页面照着这个数说「只在前几条里找了」（第五十八轮 review：原来页面里写死 5000）
        }
        result.put("offset", from);
        result.put("limit", size);
        return result;
    }

    private static boolean contains(String text, String needle) {
        return text != null && text.toLowerCase(Locale.ROOT).contains(needle);
    }

    private LambdaQueryWrapper<StudyTask> listQuery(Long userId, Integer quadrant, Integer status, Integer priority, String sortBy, String sortOrder) {
        // raw 和 wrapper 是同一个查询（lambda() 共用条件和排序）：「截止时间 IS NULL」这种排序只能用列名的写法加
        QueryWrapper<StudyTask> raw = new QueryWrapper<>();
        LambdaQueryWrapper<StudyTask> wrapper = raw.lambda()
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
            // 截止早的在前：没填截止时间的排到最后（第五十二轮）。MySQL 升序里 NULL 在最前 —— 原来选「截止时间 · 升序」，先看到的是一屏没有截止时间的
            if (asc) raw.orderByAsc("deadline IS NULL");
            wrapper.orderBy(true, asc, StudyTask::getDeadline);
        } else if ("priority".equalsIgnoreCase(sortBy)) {
            wrapper.orderBy(true, asc, StudyTask::getPriority);
        } else if ("updatedAt".equalsIgnoreCase(sortBy)) {
            wrapper.orderBy(true, asc, StudyTask::getUpdatedAt);
        } else {
            wrapper.orderByDesc(StudyTask::getUpdatedAt);
        }
        return wrapper;
    }

    /** 只有筛选、没有排序：数总数用 */
    private LambdaQueryWrapper<StudyTask> filterQuery(Long userId, Integer quadrant, Integer status, Integer priority) {
        return new LambdaQueryWrapper<StudyTask>()
                .eq(StudyTask::getUserId, userId)
                .eq(quadrant != null, StudyTask::getQuadrant, quadrant)
                .eq(status != null, StudyTask::getStatus, status)
                .eq(priority != null, StudyTask::getPriority, priority);
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
