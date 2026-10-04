package com.zhiqu.scheduler;

import com.zhiqu.common.BusinessClock;
import com.zhiqu.service.ReminderService;
import com.zhiqu.service.concurrency.RedisDistributedLockService;
import com.zhiqu.service.concurrency.ScheduledJobClaims;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

@Component
public class ReminderScheduler {
    private static final DateTimeFormatter LOCK_TIME = DateTimeFormatter.ofPattern("yyyyMMddHHmm");

    private final ReminderService reminderService;
    private final RedisDistributedLockService lockService;
    private final BusinessClock clock;
    private final ScheduledJobClaims claims;

    public ReminderScheduler(ReminderService reminderService, RedisDistributedLockService lockService, BusinessClock clock,
                             ScheduledJobClaims claims) {
        this.claims = claims;
        this.reminderService = reminderService;
        this.lockService = lockService;
        this.clock = clock;
    }

    /*
     * 「此刻」必须是业务时区的此刻：提醒的 scheduled_at 是用户那边的墙上时间（截止日早八、自己填的提醒时间），
     * 拿 JVM 默认时区的 now 去比，在 UTC 主机（Docker 默认）上差 8 小时 —— 早八那一次 now 是 00:00，
     * 当天的提醒一条都不算到期，要等到下午四点被五分钟那一路捡走；自己设的提醒时间也整体晚 8 小时。
     */

    @Scheduled(cron = "0 0 8 * * ?", zone = "Asia/Shanghai")
    public void sendDailyDdlReminders() {
        LocalDateTime now = clock.now();
        // 一天一次、按天在库里认领（第二十八轮）：好几个后端连同一个库时只有一个实例发。原来这里是一把锁 ——
        // 没有共享 Redis 时它只在本进程有效，每个开着的实例（服务器、每台电脑上的桌面应用）各发一遍汇报
        if (!claims.claim("daily-reminder", now.toLocalDate().toString())) {
            return;
        }
        reminderService.processDueReminders(now);
    }

    @Scheduled(cron = "0 */5 * * * ?", zone = "Asia/Shanghai")
    public void sendDueTaskReminders() {
        LocalDateTime now = clock.now();
        String key = "zhiqu:lock:reminder:due:" + LOCK_TIME.format(now);
        RedisDistributedLockService.LockHandle lock = lockService.tryLock(key, Duration.ofMinutes(4));
        if (lock == null) {
            return;
        }
        try {
            reminderService.processDueTaskReminders(now);
        } finally {
            lockService.unlock(lock);
        }
    }
}
