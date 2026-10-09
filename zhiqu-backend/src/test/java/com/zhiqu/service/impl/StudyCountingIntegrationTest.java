package com.zhiqu.service.impl;

import com.zhiqu.dto.StudyStatisticsVO;
import com.zhiqu.service.AchievementService;
import com.zhiqu.service.StudyRecordService;
import com.zhiqu.common.BusinessClock;
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
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 「整行取回来数」换成 COUNT / GROUP BY 之后，结果是不是还和原来一样 —— 真库、真 SQL。
 *
 * <h2>成就</h2>
 *
 * <p>迁移里种下的真成就定义，<b>解锁的是不是还是那几个</b>。
 *
 * <p>参照答案按原来的算法算：把行取回来，在 Java 里数。数据专门让每个阈值只对一种错误敏感：
 * 一条已软删除的已完成任务（漏了逻辑删除就多解锁「完成 5 个」）、同一天的多条学习记录
 * （COUNT 忘了 DISTINCT 就多解锁「学习 7 天」）、未完成与已删除的打卡（漏了哪个条件都多解锁「打卡 7 次」）。
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "app.cookie.secure=false",
        "app.rag.enabled=false"
})
class StudyCountingIntegrationTest {

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_counting_test")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @Autowired private JdbcTemplate jdbc;
    @Autowired private AchievementService achievements;
    @Autowired private StudyRecordService studyRecords;
    @Autowired private BusinessClock clock;

    @Test
    @DisplayName("COUNT 的结果与原来整行取回来数的结果一致：解锁的成就一个不多一个不少")
    void 与原算法一致() {
        jdbc.update("INSERT INTO sys_user(username,password,nickname,role,deleted,consecutive_days,total_study_minutes) "
                + "VALUES('achv-equivalence','x','a','USER',0,3,700)");
        long user = jdbc.queryForObject("SELECT id FROM sys_user WHERE username='achv-equivalence'", Long.class);

        for (int i = 0; i < 12; i++) {       // 12 条任务，其中 4 条完成
            jdbc.update("INSERT INTO study_task(user_id,title,quadrant,status,deleted) VALUES(?,?,1,?,0)", user, "t" + i, i < 4 ? 2 : 0);
        }
        jdbc.update("INSERT INTO study_task(user_id,title,quadrant,status,deleted) VALUES(?,?,1,2,1)", user, "已删除的完成任务");

        LocalDate day = LocalDate.of(2026, 9, 1);
        for (int i = 0; i < 10; i++) {       // 10 条学习记录，只有 6 个不同日期
            jdbc.update("INSERT INTO study_record(user_id,study_date,duration_minutes) VALUES(?,?,30)", user, day.plusDays(Math.min(i, 5)));
        }

        jdbc.update("INSERT INTO study_routine(user_id,title,start_date,deleted) VALUES(?,?,?,0)", user, "晨读", day);
        long routine = jdbc.queryForObject("SELECT MAX(id) FROM study_routine WHERE user_id=?", Long.class, user);
        for (int i = 0; i < 6; i++) {        // 6 次有效打卡 + 2 次未完成 + 1 次已删除
            checkin(user, routine, day.plusDays(i), 1, 0);
        }
        checkin(user, routine, day.plusDays(6), 0, 0);
        checkin(user, routine, day.plusDays(7), 0, 0);
        checkin(user, routine, day.plusDays(8), 1, 1);

        Set<String> expected = referenceUnlocks(user);
        assertTrue(expected.size() >= 5 && expected.size() < definitions().size(),
                "参照答案太空或太满，数据没起到区分作用：" + expected);

        Set<String> got = new TreeSet<>();
        achievements.checkAndUnlock(user, "test").forEach(m -> got.add(String.valueOf(m.get("code"))));
        assertEquals(expected, got);
    }

    @Test
    @DisplayName("统计页：GROUP BY 的结果与原来整行取回来数一致（软删除的不算，象限 1–4 都在）")
    void 统计与原算法一致() {
        long user = newUser("stats-equivalence");
        int[][] rows = {{1, 2}, {1, 0}, {1, 2}, {2, 1}, {2, 2}, {3, 0}, {1, 2}};
        for (int[] r : rows) {
            jdbc.update("INSERT INTO study_task(user_id,title,quadrant,status,deleted) VALUES(?,?,?,?,0)", user, "t", r[0], r[1]);
        }
        jdbc.update("INSERT INTO study_task(user_id,title,quadrant,status,deleted) VALUES(?,?,4,2,1)", user, "已删除");

        List<Map<String, Object>> live = jdbc.queryForList("SELECT quadrant, status FROM study_task WHERE user_id=? AND deleted=0", user);
        Map<Integer, Long> expectedDistribution = new java.util.HashMap<>(Map.of(1, 0L, 2, 0L, 3, 0L, 4, 0L));
        live.forEach(t -> expectedDistribution.merge(((Number) t.get("quadrant")).intValue(), 1L, Long::sum));
        long expectedDone = live.stream().filter(t -> ((Number) t.get("status")).intValue() == 2).count();

        StudyStatisticsVO got = studyRecords.statistics(user);
        assertEquals(Long.valueOf(live.size()), got.getTotalTaskCount());
        assertEquals(Long.valueOf(expectedDone), got.getCompletedTaskCount());
        assertEquals(expectedDistribution, got.getQuadrantDistribution());
        assertEquals(0L, got.getQuadrantDistribution().get(4), "软删除的那条不能算进第四象限");
    }

    @Test
    @DisplayName("趋势：同一天的记录在库里加好；窗口两端都算；窗口外和未来的不算")
    void 趋势的SQL() {
        long user = newUser("trend-sql");
        LocalDate today = clock.today();
        record(user, today, 30);
        record(user, today, 20);
        record(user, today.minusDays(StudyRecordServiceImpl.TREND_DAYS - 1), 5);
        record(user, today.minusDays(StudyRecordServiceImpl.TREND_DAYS), 7);
        record(user, today.plusDays(1), 9);

        List<Map<String, Object>> got = studyRecords.trend(user, "day");
        assertEquals(StudyRecordServiceImpl.TREND_DAYS, got.size());
        assertEquals(5, got.get(0).get("minutes"), "窗口第一天要算进来");
        assertEquals(50, got.get(got.size() - 1).get("minutes"), "同一天的两条要加起来");
        assertEquals(55, got.stream().mapToInt(m -> ((Number) m.get("minutes")).intValue()).sum(), "窗口外、未来的都不该算");
    }

    private long newUser(String name) {
        jdbc.update("INSERT INTO sys_user(username,password,nickname,role,deleted) VALUES(?,'x','u','USER',0)", name);
        return jdbc.queryForObject("SELECT id FROM sys_user WHERE username=?", Long.class, name);
    }

    private void record(long user, LocalDate day, int minutes) {
        jdbc.update("INSERT INTO study_record(user_id,study_date,duration_minutes) VALUES(?,?,?)", user, day, minutes);
    }

    private void checkin(long user, long routine, LocalDate date, int status, int deleted) {
        jdbc.update("INSERT INTO study_routine_checkin(user_id,routine_id,check_date,status,deleted) VALUES(?,?,?,?,?)",
                user, routine, date, status, deleted);
    }

    private List<Map<String, Object>> definitions() {
        return jdbc.queryForList("SELECT code, condition_type, condition_value FROM achievement_def");
    }

    /** 原来的算法：行取回来，在 Java 里数。 */
    private Set<String> referenceUnlocks(long user) {
        List<Map<String, Object>> tasks = jdbc.queryForList("SELECT status FROM study_task WHERE user_id=? AND deleted=0", user);
        List<Map<String, Object>> records = jdbc.queryForList("SELECT study_date FROM study_record WHERE user_id=?", user);
        long created = tasks.size();
        long done = tasks.stream().filter(t -> Objects.equals(((Number) t.get("status")).intValue(), 2)).count();
        long recordCount = records.size();
        long days = records.stream().map(r -> r.get("study_date")).filter(Objects::nonNull).distinct().count();
        long routineCount = jdbc.queryForList("SELECT id FROM study_routine WHERE user_id=? AND deleted=0", user).size();
        long checkinCount = jdbc.queryForList("SELECT status FROM study_routine_checkin WHERE user_id=? AND deleted=0", user)
                .stream().filter(c -> ((Number) c.get("status")).intValue() == 1).count();
        Map<String, Object> u = jdbc.queryForMap("SELECT consecutive_days, total_study_minutes FROM sys_user WHERE id=?", user);
        long consecutive = ((Number) u.get("consecutive_days")).longValue();
        long minutes = ((Number) u.get("total_study_minutes")).longValue();

        Set<String> codes = new TreeSet<>();
        for (Map<String, Object> def : definitions()) {
            Object type = def.get("condition_type");
            Object raw = def.get("condition_value");
            if (type == null || raw == null) {
                continue;
            }
            long value = ((Number) raw).longValue();
            boolean reached = switch (type.toString()) {
                case "LOGIN_COUNT" -> value <= 1;
                case "TASK_CREATED_COUNT" -> created >= value;
                case "TASK_DONE_COUNT" -> done >= value;
                case "STUDY_RECORD_COUNT" -> recordCount >= value;
                case "STUDY_DAY_COUNT" -> days >= value;
                case "ROUTINE_COUNT" -> routineCount >= value;
                case "ROUTINE_CHECKIN_COUNT" -> checkinCount >= value;
                case "CONSECUTIVE_DAYS" -> consecutive >= value;
                case "TOTAL_STUDY_MINUTES" -> minutes >= value;
                default -> false;
            };
            if (reached) {
                codes.add(def.get("code").toString());
            }
        }
        return codes;
    }
}
