package com.zhiqu.scheduler;

import com.zhiqu.common.BusinessClock;
import com.zhiqu.entity.StudyTask;
import com.zhiqu.entity.TaskReminder;
import com.zhiqu.mapper.TaskReminderMapper;
import com.zhiqu.service.ReminderService;
import com.zhiqu.service.concurrency.RedisDistributedLockService;
import com.zhiqu.service.impl.ReminderPlanServiceImpl;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Duration;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.List;
import java.util.TimeZone;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 提醒「到没到点」必须用业务时区的此刻来判。
 *
 * <p>{@code scheduled_at} 是用户的墙上时间（截止日那天早八、自己填的提醒时间）。拿 JVM 默认时区去比，
 * 在 UTC 主机（Docker 默认）上差 8 小时：早八那一次的 now 是 00:00，当天的提醒一条都不算到期；
 * 已经过去三小时的提醒时间，在 UTC 的 now 看来还在未来，会被排进队列。
 * 这里把 JVM 默认时区临时设成 UTC —— 在东八区的开发机上，裸 {@code LocalDateTime.now()} 恰好是对的，
 * 不换时区这条判据就是个看不见 bug 的绿。
 */
class ReminderClockTest {

    private static final ZoneId SHANGHAI = ZoneId.of("Asia/Shanghai");
    private final BusinessClock clock = new BusinessClock("Asia/Shanghai");
    private TimeZone saved;

    @BeforeEach
    void jvmOnUtc() {
        saved = TimeZone.getDefault();
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"));
    }

    @AfterEach
    void restore() {
        TimeZone.setDefault(saved);
    }

    @Test
    @DisplayName("调度器交给发送逻辑的「此刻」是东八区的此刻，不是 JVM 所在时区的")
    void 调度器用业务时区() {
        ReminderService service = mock(ReminderService.class);
        RedisDistributedLockService locks = mock(RedisDistributedLockService.class);
        when(locks.tryLock(anyString(), any(Duration.class))).thenReturn(new RedisDistributedLockService.LockHandle("k", "t"));
        ReminderScheduler scheduler = new ReminderScheduler(service, locks, clock);

        scheduler.sendDailyDdlReminders();
        scheduler.sendDueTaskReminders();

        ArgumentCaptor<LocalDateTime> daily = ArgumentCaptor.forClass(LocalDateTime.class);
        ArgumentCaptor<LocalDateTime> due = ArgumentCaptor.forClass(LocalDateTime.class);
        verify(service).processDueReminders(daily.capture());
        verify(service).processDueTaskReminders(due.capture());
        LocalDateTime shanghaiNow = LocalDateTime.now(SHANGHAI);
        for (LocalDateTime got : List.of(daily.getValue(), due.getValue())) {
            long minutes = Math.abs(Duration.between(got, shanghaiNow).toMinutes());
            assertTrue(minutes < 2, "交给发送逻辑的是 " + got + "，东八区此刻是 " + shanghaiNow + "（差 " + minutes + " 分钟）");
        }
    }

    @Test
    @DisplayName("自己填的提醒时间：东八区已经过去了就不排；还在未来的照排")
    void 排提醒用业务时区() {
        TaskReminderMapper mapper = mock(TaskReminderMapper.class);
        ReminderPlanServiceImpl plans = new ReminderPlanServiceImpl(mapper, clock);
        LocalDateTime shanghaiNow = LocalDateTime.now(SHANGHAI);

        plans.refreshRemindersForTask(task(shanghaiNow.minusHours(3)), null);
        verify(mapper, never()).insert(any(TaskReminder.class));

        plans.refreshRemindersForTask(task(shanghaiNow.plusHours(1)), null);
        verify(mapper, times(1)).insert(any(TaskReminder.class));
    }

    private static StudyTask task(LocalDateTime reminderTime) {
        StudyTask t = new StudyTask();
        t.setId(7L);
        t.setUserId(1L);
        t.setStatus(0);
        t.setReminderTime(reminderTime);
        return t;
    }
}
