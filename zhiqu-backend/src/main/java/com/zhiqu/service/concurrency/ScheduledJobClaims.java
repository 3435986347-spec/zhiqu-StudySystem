package com.zhiqu.service.concurrency;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * 定时任务按「哪一次」认领（第二十八轮，V43 {@code scheduled_job_claim}）：好几个后端连同一个库时，同一次只有插进去的那个实例做。
 *
 * <p>用户的部署是桌面应用和网页端连同一个远程 MySQL，每个开着的实例都会在早上 8 点跑一遍汇报。任务提醒是逐条原子认领的（不会重复），
 * 汇报里例行计划那部分不认领，靠的是 {@link RedisDistributedLockService} —— 没有共享 Redis 时它退回进程内，只在本进程有效，
 * 于是每个实例各发一遍。这里用数据库的主键做认领：不依赖 Redis，所有实例都连着同一个库。
 *
 * <p>认领了的实例做到一半没了，那一次就没人补（任务提醒自己有「认领超时重排」，例行计划那部分会少一天）。
 */
@Component
public class ScheduledJobClaims {

    private final JdbcTemplate jdbc;

    public ScheduledJobClaims(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** 认领 {@code job} 的 {@code slot} 这一次（比如「daily-reminder」的「2026-10-04」）。返回 true 才做。 */
    public boolean claim(String job, String slot) {
        return jdbc.update("INSERT IGNORE INTO scheduled_job_claim(job, slot) VALUES (?, ?)", job, slot) == 1;
    }
}
