package com.zhiqu.service.impl;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.common.BusinessClock;
import com.zhiqu.common.BusinessException;
import com.zhiqu.dto.StudyRecordCreateRequest;
import com.zhiqu.dto.StudyStatisticsVO;
import com.zhiqu.entity.StudyRecord;
import com.zhiqu.entity.StudyTask;
import com.zhiqu.entity.SysUser;
import com.zhiqu.mapper.StudyRecordMapper;
import com.zhiqu.mapper.StudyTaskMapper;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.service.AchievementService;
import com.zhiqu.service.StudyRecordService;
import com.zhiqu.service.concurrency.DeadlockRetry;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.temporal.WeekFields;
import java.util.*;
import java.util.stream.Collectors;

@Service
public class StudyRecordServiceImpl implements StudyRecordService {
    private final StudyRecordMapper studyRecordMapper;
    private final SysUserMapper sysUserMapper;
    private final StudyTaskMapper studyTaskMapper;
    private final AchievementService achievementService;
    private final BusinessClock clock;

    public StudyRecordServiceImpl(StudyRecordMapper studyRecordMapper, SysUserMapper sysUserMapper,
                                  StudyTaskMapper studyTaskMapper, AchievementService achievementService,
                                  BusinessClock clock) {
        this.studyRecordMapper = studyRecordMapper;
        this.sysUserMapper = sysUserMapper;
        this.studyTaskMapper = studyTaskMapper;
        this.achievementService = achievementService;
        this.clock = clock;
    }

    @Override
    @Transactional
    @DeadlockRetry
    public StudyRecord create(Long userId, StudyRecordCreateRequest request) {
        StudyRecord record = new StudyRecord();
        record.setUserId(userId);
        if (request.getTaskId() != null) {
            StudyTask task = studyTaskMapper.selectOne(new LambdaQueryWrapper<StudyTask>()
                    .eq(StudyTask::getId, request.getTaskId())
                    .eq(StudyTask::getUserId, userId));
            if (task == null) {
                throw new BusinessException("任务不存在或无权限关联学习记录");
            }
            record.setTaskId(request.getTaskId());
        }
        // 学习日期不能晚于今天（第二十一轮）。连续天数的 SQL 只往前挪 last_study_date：一条记到将来的记录
        //（UTC+14 的浏览器、快了一年的电脑时钟）之后，所有真实的记录都算「过去的」，连续天数冻在那儿直到那一天
        LocalDate studyDate = request.getStudyDate() == null ? clock.today() : request.getStudyDate();
        if (studyDate.isAfter(clock.today())) {
            throw new BusinessException("学习日期 " + studyDate + " 还没到（今天是 " + clock.today() + "）");
        }
        record.setStudyDate(studyDate);
        record.setDurationMinutes(request.getDurationMinutes());
        record.setNote(request.getNote());
        studyRecordMapper.insert(record);

        sysUserMapper.addStudyMinutesAndRefreshStreak(userId, request.getDurationMinutes(), studyDate);
        achievementService.checkAndUnlock(userId, "study_record_added");
        return record;
    }

    @Override
    public List<StudyRecord> list(Long userId, LocalDate from, LocalDate to) {
        return studyRecordMapper.selectList(new LambdaQueryWrapper<StudyRecord>()
                .eq(StudyRecord::getUserId, userId)
                .ge(from != null, StudyRecord::getStudyDate, from)
                .le(to != null, StudyRecord::getStudyDate, to)
                .orderByDesc(StudyRecord::getStudyDate));
    }

    /**
     * 统计页的几个数。原来把这个人的全部任务整行取回来（加密的标题、描述一起）只为数个数；
     * 现在一条 GROUP BY。软删除的照旧不算（原来靠 {@code @TableLogic}，这里写在 SQL 里）。
     */
    @Override
    public StudyStatisticsVO statistics(Long userId) {
        SysUser user = sysUserMapper.selectById(userId);
        Map<Integer, Long> distribution = new HashMap<>();
        long totalTask = 0;
        long completedTask = 0;
        for (Map<String, Object> row : studyTaskMapper.countByQuadrantAndStatus(userId)) {
            long n = ((Number) row.get("n")).longValue();
            distribution.merge(((Number) row.get("quadrant")).intValue(), n, Long::sum);
            totalTask += n;
            Object status = row.get("status");
            if (status != null && ((Number) status).intValue() == 2) {
                completedTask += n;
            }
        }
        for (int i = 1; i <= 4; i++) {
            distribution.putIfAbsent(i, 0L);
        }

        return StudyStatisticsVO.builder()
                .consecutiveDays(user == null || user.getConsecutiveDays() == null ? 0 : user.getConsecutiveDays())
                .totalStudyMinutes(user == null || user.getTotalStudyMinutes() == null ? 0 : user.getTotalStudyMinutes())
                .completedTaskCount(completedTask)
                .totalTaskCount(totalTask)
                .quadrantDistribution(distribution)
                .build();
    }

    /** 趋势图的窗口，照统计页的设计稿：最近 14 天、7 周、6 个月。 */
    static final int TREND_DAYS = 14;
    static final int TREND_WEEKS = 7;
    static final int TREND_MONTHS = 6;

    /**
     * 学习时长趋势：截止到业务上的今天、<b>连续</b>的若干格，没学的那格是 0。
     *
     * <p>原来的版本有四个问题：返回<b>全部</b>历史（学了两年的人「日」视图是几百根挤在一行的柱子，
     * 而且每次都把全部记录取回来）；没学的日子直接缺席，相邻两根柱子不一定是相邻两天；
     * 周的键用 {@code getYear()} 配「按周计年」的周序号 —— 2024-12-30 属于 2025 年第 1 周，键却是
     * {@code 2024-W1}，和一年前真正的第 1 周<b>合并</b>成一根；键没补零，按字符串排 W10 在 W2 前面；
     * 一周从哪天开始跟着服务器的语言走（en_US 的主机上是周日）。
     * 现在周按 ISO（周一开始），键补零、按周计年；{@code label} 是给人看的（「6/20」「第25周」「6月」），
     * 前端本来就优先显示它。
     */
    @Override
    public List<Map<String, Object>> trend(Long userId, String type) {
        return trend(userId, type, clock.today());
    }

    List<Map<String, Object>> trend(Long userId, String type, LocalDate today) {
        String unit = "week".equalsIgnoreCase(type) ? "week" : "month".equalsIgnoreCase(type) ? "month" : "day";
        LocalDate last = periodStart(unit, today);
        int count = switch (unit) {
            case "week" -> TREND_WEEKS;
            case "month" -> TREND_MONTHS;
            default -> TREND_DAYS;
        };
        Map<LocalDate, Integer> buckets = new LinkedHashMap<>();
        for (int i = count - 1; i >= 0; i--) {
            buckets.put(switch (unit) {
                case "week" -> last.minusWeeks(i);
                case "month" -> last.minusMonths(i);
                default -> last.minusDays(i);
            }, 0);
        }
        LocalDate from = buckets.keySet().iterator().next();
        for (Map<String, Object> row : studyRecordMapper.minutesByDay(userId, from, today)) {
            LocalDate day = toLocalDate(row.get("studyDate"));
            Object minutes = row.get("minutes");
            if (day != null && minutes != null) {
                buckets.computeIfPresent(periodStart(unit, day), (k, v) -> v + ((Number) minutes).intValue());
            }
        }

        List<Map<String, Object>> result = new ArrayList<>();
        buckets.forEach((start, minutes) -> result.add(Map.of(
                "period", periodKey(unit, start),
                "label", periodLabel(unit, start),
                "minutes", minutes)));
        return result;
    }

    static LocalDate periodStart(String unit, LocalDate day) {
        return switch (unit) {
            case "week" -> day.with(WeekFields.ISO.dayOfWeek(), 1);
            case "month" -> day.withDayOfMonth(1);
            default -> day;
        };
    }

    static String periodKey(String unit, LocalDate start) {
        return switch (unit) {
            case "week" -> String.format("%d-W%02d", start.get(WeekFields.ISO.weekBasedYear()),
                    start.get(WeekFields.ISO.weekOfWeekBasedYear()));
            case "month" -> String.format("%d-%02d", start.getYear(), start.getMonthValue());
            default -> start.toString();
        };
    }

    static String periodLabel(String unit, LocalDate start) {
        return switch (unit) {
            case "week" -> "第" + start.get(WeekFields.ISO.weekOfWeekBasedYear()) + "周";
            case "month" -> start.getMonthValue() + "月";
            default -> start.getMonthValue() + "/" + start.getDayOfMonth();
        };
    }

    /** 驱动按 DATE 回来的可能是 {@code java.sql.Date} 也可能是 {@code LocalDate}，两种都认。 */
    private static LocalDate toLocalDate(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof LocalDate d) {
            return d;
        }
        if (value instanceof java.sql.Date d) {
            return d.toLocalDate();
        }
        return LocalDate.parse(value.toString().substring(0, 10));
    }
}
