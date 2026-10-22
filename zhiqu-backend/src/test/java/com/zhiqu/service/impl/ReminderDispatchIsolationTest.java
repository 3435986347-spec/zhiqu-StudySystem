package com.zhiqu.service.impl;

import com.zhiqu.entity.StudyTask;
import com.zhiqu.entity.TaskReminder;
import com.zhiqu.entity.UserReminderSetting;
import com.zhiqu.mapper.StudyTaskMapper;
import com.zhiqu.mapper.TaskReminderMapper;
import com.zhiqu.mapper.UserReminderSettingMapper;
import com.zhiqu.service.RoutineService;
import com.zhiqu.service.notification.NotificationChannel;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import com.zhiqu.service.privacy.TaskPrivacyService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.InOrder;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 发提醒的那一轮：一个人、一条任务、一次查询出错，只影响它自己 —— 原来一个异常就让整批停在 PROCESSING，
 * 而 PROCESSING 是只进不出的状态，排在后面的人这一轮全都收不到、以后也不会再发。
 */
class ReminderDispatchIsolationTest {

    private final UserReminderSettingMapper settings = mock(UserReminderSettingMapper.class);
    private final TaskReminderMapper reminders = mock(TaskReminderMapper.class);
    private final StudyTaskMapper tasks = mock(StudyTaskMapper.class);
    private final RoutineService routines = mock(RoutineService.class);
    private final TaskPrivacyService privacy = mock(TaskPrivacyService.class);
    private final List<String> sent = new ArrayList<>();

    private final NotificationChannel channel = new NotificationChannel() {
        @Override
        public String channel() {
            return "WECOM";
        }

        @Override
        public void send(UserReminderSetting setting, String content) {
            sent.add(content);
        }
    };

    private final ReminderServiceImpl service = new ReminderServiceImpl(settings, reminders, tasks, routines, privacy,
            List.of(channel), mock(SensitiveCryptoService.class));

    private final LocalDateTime now = LocalDateTime.of(2026, 9, 25, 8, 0);

    private TaskReminder reminder(long id, long userId, long taskId) {
        TaskReminder r = new TaskReminder();
        r.setId(id);
        r.setUserId(userId);
        r.setTaskId(taskId);
        r.setOffsetDays(1);
        r.setScheduledAt(now);
        r.setStatus("PENDING");
        return r;
    }

    private StudyTask task(long id, String title) {
        StudyTask t = new StudyTask();
        t.setId(id);
        t.setTitle(title);
        t.setStatus(0);
        t.setDeadline(now.plusDays(1));
        when(tasks.selectById(id)).thenReturn(t);
        when(privacy.reveal(t)).thenReturn(t);
        return t;
    }

    private static UserReminderSetting enabled() {
        UserReminderSetting s = new UserReminderSetting();
        s.setChannel("WECOM");
        s.setEnabled(1);
        s.setWebhookUrl("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x");
        return s;
    }

    private void due(TaskReminder... rows) {
        when(reminders.selectList(any())).thenReturn(new ArrayList<>(List.of(rows)));
        when(reminders.claimPending(anyLong())).thenReturn(1);
    }

    @Test
    @DisplayName("一条任务读不出来（坏密文）：只这一条失败；同一个人的其他提醒、别人的提醒照发")
    void 坏任务只影响它自己() {
        TaskReminder bad = reminder(1, 1, 11);
        TaskReminder goodSameUser = reminder(2, 1, 12);
        TaskReminder otherUser = reminder(3, 2, 21);
        StudyTask broken = task(11, "坏掉的那条");
        when(privacy.reveal(broken)).thenThrow(new IllegalStateException("密文坏了"));
        task(12, "同一个人的另一条");
        task(21, "别人的那条");
        when(settings.selectOne(any())).thenReturn(enabled());
        due(bad, goodSameUser, otherUser);

        assertDoesNotThrow(() -> service.processDueTaskReminders(now));

        assertEquals("FAILED", bad.getStatus());
        assertTrue(bad.getFailureReason().contains("读不出来"), bad.getFailureReason());
        assertEquals("SENT", goodSameUser.getStatus(), "同一个人的其他提醒被连累了");
        assertEquals("SENT", otherUser.getStatus(), "排在后面的人被连累了");
        assertTrue(sent.stream().anyMatch(m -> m.contains("同一个人的另一条")));
        assertTrue(sent.stream().anyMatch(m -> m.contains("别人的那条")));
    }

    @Test
    @DisplayName("查某个人的设置时出错：他这一批标失败（不停在 PROCESSING），后面的人照发")
    void 一个人出错不连累别人() {
        TaskReminder first = reminder(1, 1, 11);
        TaskReminder second = reminder(2, 2, 21);
        task(11, "第一个人的");
        task(21, "第二个人的");
        AtomicInteger calls = new AtomicInteger();
        when(settings.selectOne(any())).thenAnswer(inv -> {
            if (calls.getAndIncrement() == 0) {
                throw new IllegalStateException("连接被重置");
            }
            return enabled();
        });
        due(first, second);

        assertDoesNotThrow(() -> service.processDueTaskReminders(now));

        assertEquals("FAILED", first.getStatus(), "出错的那个人的提醒不能停在 PROCESSING");
        assertTrue(first.getFailureReason().contains("连接被重置"), first.getFailureReason());
        assertEquals("SENT", second.getStatus());
    }

    @Test
    @DisplayName("例行计划取不出来：任务提醒照发，而且不会有认领了却没处理的")
    void 例行计划出错不连累任务提醒() {
        TaskReminder r = reminder(1, 1, 11);
        task(11, "任务提醒");
        when(settings.selectOne(any())).thenReturn(enabled());
        when(routines.reminderInstances(any(LocalDate.class))).thenThrow(new IllegalStateException("例行计划表坏了"));
        due(r);

        assertDoesNotThrow(() -> service.processDueReminders(now));

        assertEquals("SENT", r.getStatus());
        assertEquals(1, sent.size());
    }

    @Test
    @DisplayName("每一轮先收回中断的：先判死重排过的，再把第一次中断的放回队列，然后才取到期的")
    void 先收回中断的() {
        due();
        service.processDueTaskReminders(now);
        InOrder order = inOrder(reminders);
        order.verify(reminders).failStaleRequeued(anyInt(), anyString(), anyString());
        order.verify(reminders).requeueStale(anyInt(), anyString());
        order.verify(reminders).selectList(any());
    }
}
