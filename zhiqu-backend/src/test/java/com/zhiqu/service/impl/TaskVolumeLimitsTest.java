package com.zhiqu.service.impl;

import com.zhiqu.common.BusinessClock;
import com.zhiqu.common.BusinessException;
import com.zhiqu.dto.TaskCreateRequest;
import com.zhiqu.entity.StudyTask;
import com.zhiqu.entity.TaskReminder;
import com.zhiqu.mapper.StudyTaskMapper;
import com.zhiqu.mapper.TaskReminderMapper;
import com.zhiqu.service.AchievementService;
import com.zhiqu.service.ReminderPlanService;
import com.zhiqu.service.privacy.TaskPrivacyService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

/**
 * 一次请求最多写多少行：周期任务最多 52 周、每个任务最多 10 个提前提醒。原来都没有上限 ——
 * repeatWeeks = 1000000（或者 AI 草稿里模型随口写的 520）就是一个事务里几百万行写入。
 */
class TaskVolumeLimitsTest {

    private final StudyTaskMapper tasks = mock(StudyTaskMapper.class);
    private final TaskReminderMapper reminders = mock(TaskReminderMapper.class);
    private final StudyTaskServiceImpl taskService = new StudyTaskServiceImpl(tasks, mock(AchievementService.class),
            mock(ReminderPlanService.class), mock(TaskPrivacyService.class));
    private final ReminderPlanServiceImpl plans = new ReminderPlanServiceImpl(reminders, new BusinessClock("Asia/Shanghai"));

    private static TaskCreateRequest repeating(int weeks) {
        TaskCreateRequest r = new TaskCreateRequest();
        r.setTitle("每周复习");
        r.setQuadrant(2);
        r.setStartTime(LocalDateTime.now().plusDays(1));
        r.setRepeatWeeks(weeks);
        return r;
    }

    @Test
    @DisplayName("周期任务：正好 52 周可以（52 条）；53 周直接拒绝，一条都不写")
    void 周期最多52周() {
        taskService.createRepeated(1L, repeating(StudyTaskServiceImpl.MAX_REPEAT_WEEKS));
        verify(tasks, times(52)).insert(any(StudyTask.class));

        StudyTaskMapper untouched = mock(StudyTaskMapper.class);
        StudyTaskServiceImpl fresh = new StudyTaskServiceImpl(untouched, mock(AchievementService.class),
                mock(ReminderPlanService.class), mock(TaskPrivacyService.class));
        BusinessException e = assertThrows(BusinessException.class, () -> fresh.createRepeated(1L, repeating(53)));
        assertTrue(e.getMessage().contains("最多 52 周"), e.getMessage());
        verify(untouched, never()).insert(any(StudyTask.class));
    }

    private static StudyTask farDeadline() {
        StudyTask t = new StudyTask();
        t.setId(1L);
        t.setUserId(1L);
        t.setStatus(0);
        t.setDeadline(LocalDateTime.now().plusYears(2));
        return t;
    }

    private static List<Integer> range(int from, int count) {
        List<Integer> out = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            out.add(from + i);
        }
        return out;
    }

    @Test
    @DisplayName("提前提醒：正好 10 个可以；11 个拒绝并说清上限（不悄悄只留前几个）")
    void 提醒最多10个() {
        plans.refreshRemindersForTask(farDeadline(), range(1, ReminderPlanServiceImpl.MAX_OFFSETS));
        verify(reminders, times(10)).insert(any(TaskReminder.class));

        BusinessException e = assertThrows(BusinessException.class,
                () -> plans.refreshRemindersForTask(farDeadline(), range(1, 11)));
        assertTrue(e.getMessage().contains("最多 10 个"), e.getMessage());
    }

    @Test
    @DisplayName("重复的偏移算一个；不指定时的默认建议（最多 5 个）不受影响")
    void 重复与默认() {
        plans.refreshRemindersForTask(farDeadline(), Collections.nCopies(20, 3));
        verify(reminders, times(1)).insert(any(TaskReminder.class));

        TaskReminderMapper fresh = mock(TaskReminderMapper.class);
        StudyTask exam = farDeadline();
        exam.setTaskType("考试");
        new ReminderPlanServiceImpl(fresh, new BusinessClock("Asia/Shanghai")).refreshRemindersForTask(exam, null);
        verify(fresh, times(5)).insert(any(TaskReminder.class));
    }
}
