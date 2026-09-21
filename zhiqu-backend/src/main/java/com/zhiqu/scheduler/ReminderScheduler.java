package com.zhiqu.scheduler;

import com.zhiqu.service.ReminderService;
import com.zhiqu.service.concurrency.RedisDistributedLockService;
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

    public ReminderScheduler(ReminderService reminderService, RedisDistributedLockService lockService) {
        this.reminderService = reminderService;
        this.lockService = lockService;
    }

    @Scheduled(cron = "0 0 8 * * ?", zone = "Asia/Shanghai")
    public void sendDailyDdlReminders() {
        LocalDateTime now = LocalDateTime.now();
        String key = "zhiqu:lock:reminder:daily:" + LOCK_TIME.format(now);
        RedisDistributedLockService.LockHandle lock = lockService.tryLock(key, Duration.ofMinutes(20));
        if (lock == null) {
            return;
        }
        try {
            reminderService.processDueReminders(now);
        } finally {
            lockService.unlock(lock);
        }
    }

    @Scheduled(cron = "0 */5 * * * ?", zone = "Asia/Shanghai")
    public void sendDueTaskReminders() {
        LocalDateTime now = LocalDateTime.now();
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
