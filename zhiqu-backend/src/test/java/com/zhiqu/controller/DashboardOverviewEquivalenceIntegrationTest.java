package com.zhiqu.controller;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.common.BusinessClock;
import com.zhiqu.entity.StudyTask;
import com.zhiqu.mapper.StudyTaskMapper;
import com.zhiqu.service.RoutineService;
import com.zhiqu.service.privacy.TaskPrivacyService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfSystemProperty;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 首页只取「用得到的任务」之后，拼出来的首页和原来「全部取回来」时<b>一模一样</b> —— 真库、真 SQL。
 * 同一个 {@link DashboardController#build}，一次喂全部任务、一次喂 {@link DashboardController#relevantTasks}，比输出。
 *
 * <p>数据专门覆盖查询条件里每一个分支的边：有开始时间看开始时间（截止时间落在区间里也不算）、
 * 没开始时间才看截止时间、今天的（不在所看区间里时也要算进今日计数）、status 为 NULL 算没完成、软删除的不算。
 * 顺带钉早八那一次的「今天打过卡没有」（按 routine_id 分批 IN）。
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "spring.task.scheduling.enabled=false",
        "app.cookie.secure=false",
        "app.rag.enabled=false"
})
class DashboardOverviewEquivalenceIntegrationTest {

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_dashboard_test")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @Autowired private JdbcTemplate jdbc;
    @Autowired private DashboardController dashboard;
    @Autowired private StudyTaskMapper tasks;
    @Autowired private TaskPrivacyService privacy;
    @Autowired private RoutineService routines;
    @Autowired private BusinessClock clock;

    private long user(String name) {
        jdbc.update("INSERT INTO sys_user(username,password,nickname,role,deleted) VALUES(?,'x','u','USER',0)", name);
        return jdbc.queryForObject("SELECT id FROM sys_user WHERE username=?", Long.class, name);
    }

    private void task(long user, String title, int quadrant, Integer status, LocalDateTime start, LocalDateTime deadline, int deleted) {
        jdbc.update("INSERT INTO study_task(user_id,title,quadrant,status,start_time,deadline,deleted,priority) VALUES(?,?,?,?,?,?,?,1)",
                user, title, quadrant, status, start, deadline, deleted);
    }

    @Test
    @DisplayName("只取用得到的任务：首页输出与全部取回来时一致（区间含今天、不含今天各比一次），而且确实少取了")
    void 首页与原算法一致() {
        long u = user("dash-equivalence");
        LocalDate today = clock.today();
        LocalDateTime noon = today.atTime(12, 0);
        task(u, "很早以前完成的", 1, 2, noon.minusDays(400), noon.minusDays(399), 0);
        task(u, "区间里完成的（按开始时间）", 2, 2, noon.minusDays(1), null, 0);
        task(u, "今天完成的（只有截止时间）", 3, 2, null, noon, 0);
        task(u, "逾期没完成", 1, 0, null, noon.minusDays(10), 0);
        task(u, "将来截止没完成", 2, 1, null, noon.plusDays(30), 0);
        task(u, "没有日期没完成", 4, 0, null, null, 0);
        task(u, "状态为空", 3, null, null, noon.plusDays(2), 0);
        task(u, "已删除没完成", 1, 0, null, noon, 1);
        task(u, "完成了：开始时间在区间外、截止时间在区间里（看开始时间 → 不算）", 2, 2, noon.minusDays(90), noon, 0);
        task(u, "完成了：没开始时间、截止在区间里", 4, 2, null, noon.plusDays(1), 0);
        task(u, "完成了：一个月前", 1, 2, noon.minusDays(37), null, 0);
        task(u, "完成了：区间第一天零点", 3, 2, today.minusDays(3).atStartOfDay(), null, 0);
        task(u, "完成了：区间最后一天深夜", 3, 2, today.plusDays(3).atTime(23, 30), null, 0);
        task(u, "完成了：区间后一天零点", 3, 2, today.plusDays(4).atStartOfDay(), null, 0);

        List<StudyTask> all = privacy.revealAll(tasks.selectList(new LambdaQueryWrapper<StudyTask>()
                .eq(StudyTask::getUserId, u)
                .orderByAsc(StudyTask::getDeadline)
                .orderByDesc(StudyTask::getPriority)
                .orderByDesc(StudyTask::getUpdatedAt)));

        for (LocalDate[] range : List.of(
                new LocalDate[]{today.minusDays(3), today.plusDays(3)},       // 含今天
                new LocalDate[]{today.minusDays(40), today.minusDays(34)})) { // 不含今天：今日计数只能靠「今天」那一支
            List<StudyTask> relevant = dashboard.relevantTasks(u, range[0], range[1], today);
            assertTrue(relevant.size() < all.size(), "没有少取任何任务，这个优化什么也没做");
            // 取回来的正好是「没完成 / 日期在区间里 / 日期是今天」这些 —— 多取了输出也一样（build 会再筛），所以要单独钉
            LocalDate from = range[0];
            LocalDate to = range[1];
            java.util.Set<String> want = new java.util.TreeSet<>();
            for (StudyTask t : all) {
                LocalDate date = t.getStartTime() != null ? t.getStartTime().toLocalDate()
                        : t.getDeadline() != null ? t.getDeadline().toLocalDate() : null;
                boolean open = t.getStatus() == null || t.getStatus() != 2;
                boolean inRange = date != null && !date.isBefore(from) && !date.isAfter(to);
                if (open || inRange || today.equals(date)) {
                    want.add(t.getTitle());
                }
            }
            java.util.Set<String> gotTitles = new java.util.TreeSet<>();
            relevant.forEach(t -> gotTitles.add(t.getTitle()));
            assertEquals(want, gotTitles, "区间 " + from + " ~ " + to + " 取回来的任务不对");
            Map<String, Object> expected = dashboard.build(u, range[0], range[1], today, all);
            Map<String, Object> got = dashboard.build(u, range[0], range[1], today, relevant);
            assertEquals(expected, got, "区间 " + range[0] + " ~ " + range[1] + " 的首页和原来不一样");
        }
    }

    @Test
    @DisplayName("早八：打过卡（status=1、当天、同一个用户）的不提醒；没完成的打卡、别的日子的打卡照样提醒")
    void 早八打卡查询() {
        long u = user("routine-reminder");
        long other = user("routine-reminder-other");
        LocalDate day = LocalDate.of(2026, 9, 25);
        long doneRoutine = routine(u, "晨读", day);
        long notDone = routine(u, "背单词", day);
        long yesterdayOnly = routine(u, "跑步", day);
        long wrongUser = routine(u, "练字", day);
        checkin(u, doneRoutine, day, 1);
        checkin(u, notDone, day, 0);
        checkin(u, yesterdayOnly, day.minusDays(1), 1);
        checkin(other, wrongUser, day, 1);

        List<Object> due = routines.reminderInstances(day).stream()
                .filter(r -> ((Number) r.get("userId")).longValue() == u)
                .map(r -> r.get("title")).toList();
        assertEquals(3, due.size(), due.toString());
        assertEquals(java.util.Set.of("背单词", "跑步", "练字"), new java.util.HashSet<>(due));
    }

    private long routine(long user, String title, LocalDate start) {
        jdbc.update("INSERT INTO study_routine(user_id,title,start_date,frequency,reminder_enabled,deleted) VALUES(?,?,?,'DAILY',1,0)", user, title, start);
        return jdbc.queryForObject("SELECT MAX(id) FROM study_routine WHERE user_id=?", Long.class, user);
    }

    private void checkin(long user, long routine, LocalDate date, int status) {
        jdbc.update("INSERT INTO study_routine_checkin(user_id,routine_id,check_date,status,deleted) VALUES(?,?,?,?,0)", user, routine, date, status);
    }
}
