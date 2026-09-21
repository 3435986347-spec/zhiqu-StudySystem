package com.zhiqu.common;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;

/**
 * 「今天是哪一天」的<b>唯一判定处</b>。
 *
 * <h2>此前系统里有两套「今天」</h2>
 *
 * <p>AI 侧用 {@code LocalDate.now(ZoneId.of("Asia/Shanghai"))}，并把它写进提示词：
 * 「今天是 %s，时区是 Asia/Shanghai」，模型据此产出任务日期。
 * 而看板的「今日任务」、例行计划的打卡日期与排期，用的是裸 {@code LocalDate.now()} ——
 * <b>JVM 默认时区</b>。
 *
 * <p>而 JVM 时区在这个仓库里<b>哪里都没有钉</b>：部署文档没提，启动命令没加
 * {@code -Duser.timezone}，代码里也没有 {@code TimeZone.setDefault}。
 * 唯一的时区声明是 JDBC URL 里的 {@code serverTimezone}，那管的是驱动怎么解释时间戳，
 * 不是 JVM 认为今天几号。
 *
 * <p>于是在一台不是东八区的机器上（Docker 默认是 UTC），凌晨 0 点到 8 点之间：
 * AI 说「今天是 21 号」并生成 21 号的任务，而看板按 20 号筛、打卡记成 20 号、
 * 连续天数跟着错。两边都「正确」，只是问的不是同一个问题。
 *
 * <h2>为什么日期可以统一而时间戳不必</h2>
 *
 * <p>{@code LocalDate} 一旦写进库就不带时区了，所以唯一的问题是「此刻算哪一天」——
 * 把这个判断收成一处就够了。而 {@code created_at} 这类审计时间戳只要在同一个 JVM 内
 * 自洽即可，不在本类的职责范围内。
 */
@Component
public class BusinessClock {
    /**
     * 业务时区。
     *
     * <p>默认东八区 —— 这个产品面向国内学生，提醒的 cron 也写死在这个时区上。
     * 改它的话，{@code ReminderScheduler} 上那两个 {@code @Scheduled(zone = ...)}
     * 必须一起改：注解里只能写常量，没法读配置，所以那一致性由
     * {@code BusinessClockWiringTest} 钉住。
     */
    private final ZoneId zone;

    public BusinessClock(@Value("${app.timezone:" + DEFAULT_ZONE + "}") String timezone) {
        this.zone = ZoneId.of(timezone == null || timezone.isBlank() ? DEFAULT_ZONE : timezone.trim());
    }

    /** 默认业务时区 —— 与 {@code ReminderScheduler} 的 cron zone 必须一致。 */
    public static final String DEFAULT_ZONE = "Asia/Shanghai";

    public ZoneId zone() {
        return zone;
    }

    /** 业务意义上的今天。 */
    public LocalDate today() {
        return LocalDate.now(zone);
    }

    /** 业务时区的此刻 —— 需要同时用到日期与时间时用它，避免两者来自不同时区。 */
    public LocalDateTime now() {
        return LocalDateTime.now(zone);
    }
}
