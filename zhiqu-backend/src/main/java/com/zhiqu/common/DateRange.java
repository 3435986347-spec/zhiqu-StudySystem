package com.zhiqu.common;

import java.time.LocalDate;
import java.time.temporal.ChronoUnit;

/**
 * 按日期区间逐天展开的接口（首页的一周视图、例行计划的实例）共用的上限 —— 唯一定义。
 *
 * <p>原来 {@code from} / {@code to} 原样照收：一个登录用户请求 {@code from=2000-01-01&to=2100-12-31}，
 * 服务器就逐天展开三万六千多天、每天再遍历一遍例行计划，拼出一个几十 MB 的响应。页面实际只要一周；
 * 一年留足了余量。
 */
public final class DateRange {

    public static final int MAX_DAYS = 366;

    private DateRange() {
    }

    /** 两端都含；超过 {@link #MAX_DAYS} 天就拒绝，说清上限。 */
    public static void requireWithin(LocalDate from, LocalDate to) {
        long days = ChronoUnit.DAYS.between(from, to) + 1;
        if (days > MAX_DAYS) {
            throw new BusinessException("日期范围最多 " + MAX_DAYS + " 天（这次是 " + days + " 天）");
        }
    }
}
