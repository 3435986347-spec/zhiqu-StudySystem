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

    /**
     * 早上 8 点的汇报。8 点那一个小时里每 10 分钟来一趟，按天认领、只有一个实例做成一次（第四十七轮）：
     * 原来只在 8:00 跑一次，认领之后出错（库一时连不上），认领留着、别的实例跳过，那天的汇报谁都不发了。
     * 出错时放回认领 —— processDueReminders 抛出来的只会是发之前那几步（每个人的发送各自兜底，不往外抛），这时还什么都没发，重来不会发两遍。
     */
    @Scheduled(cron = "0 0/10 8 * * ?", zone = "Asia/Shanghai")
    public void sendDailyDdlReminders() {
        LocalDateTime now = clock.now();
        // 一天一次、按天在库里认领（第二十八轮）：好几个后端连同一个库时只有一个实例发。原来这里是一把锁 ——
        // 没有共享 Redis 时它只在本进程有效，每个开着的实例（服务器、每台电脑上的桌面应用）各发一遍汇报
        String day = now.toLocalDate().toString();
        if (!claims.claim("daily-reminder", day)) {
            return;
        }
        try {
            reminderService.processDueReminders(now);
        } catch (RuntimeException e) {
            claims.release("daily-reminder", day);
            throw e;
        }
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
