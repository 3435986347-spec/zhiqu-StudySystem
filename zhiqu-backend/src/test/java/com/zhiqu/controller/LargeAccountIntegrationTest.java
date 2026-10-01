package com.zhiqu.controller;

import com.zhiqu.dto.TaskCreateRequest;
import com.zhiqu.entity.StudyRecord;
import com.zhiqu.entity.StudyTask;
import com.zhiqu.service.StudyRecordService;
import com.zhiqu.service.StudyTaskService;
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
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 用了很久的账号（第十七轮）：几千条任务、几千条学习记录。原来任务页、例行计划页、统计页、看板都把全部任务 / 记录取回来，
 * 看一周的首页回 1.1MB（一半是没人读的重复数据）。
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "app.cookie.secure=false",
        "app.rag.enabled=false"
})
class LargeAccountIntegrationTest {

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_large_test")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @Autowired private JdbcTemplate jdbc;
    @Autowired private StudyTaskService tasks;
    @Autowired private StudyRecordService records;
    @Autowired private DashboardController dashboard;

    private long newUser(String name) {
        jdbc.update("INSERT INTO sys_user(username, password, nickname, role, status, deleted) VALUES (?, 'x', ?, 'USER', 1, 0)", name, name);
        return jdbc.queryForObject("SELECT id FROM sys_user WHERE username = ?", Long.class, name);
    }

    private void createTasks(long userId, int n) {
        for (int i = 0; i < n; i++) {
            TaskCreateRequest r = new TaskCreateRequest();
            r.setTitle("任务 " + i);
            r.setQuadrant(1 + i % 4);
            r.setPriority(1);
            r.setStatus(i % 3 == 0 ? 2 : 0);
            tasks.create(userId, r);
        }
    }

    @SuppressWarnings("unchecked")
    @Test
    @DisplayName("分页：同一时刻改过的几百条（updatedAt 全一样）翻完正好每条一次；总数、筛选、上限都对")
    void 分页不重不漏() {
        long user = newUser("big_page");
        createTasks(user, 250);
        jdbc.update("UPDATE study_task SET updated_at = '2026-09-28 10:00:00' WHERE user_id = ?", user);   // 全都并列：只按 updatedAt 排就会乱
        Set<Long> seen = new HashSet<>();
        int pages = 0;
        for (int offset = 0; ; offset += 100) {
            Map<String, Object> page = tasks.page(user, null, null, null, "updatedAt", "desc", offset, 100);
            assertEquals(250L, ((Number) page.get("total")).longValue());
            List<StudyTask> items = (List<StudyTask>) page.get("items");
            if (items.isEmpty()) break;
            pages++;
            for (StudyTask t : items) {
                assertTrue(seen.add(t.getId()), "翻页时同一条出现了两次：" + t.getId());
                assertEquals(user, t.getUserId());
                assertTrue(t.getTitle().startsWith("任务 "), "标题要解密好：" + t.getTitle());
            }
        }
        assertEquals(250, seen.size(), "翻完没拿全");
        assertEquals(3, pages);

        Map<String, Object> done = tasks.page(user, null, 2, null, null, null, 0, 1000);
        assertEquals(84L, ((Number) done.get("total")).longValue());
        assertEquals(84, ((List<?>) done.get("items")).size());
        assertEquals(500, ((Number) tasks.page(user, null, null, null, null, null, 0, 100000).get("limit")).intValue(), "一页的上限");
        assertTrue(((List<?>) tasks.page(user, null, null, null, null, null, 9999, 100).get("items")).isEmpty());
    }

    @Test
    @DisplayName("学习记录按日期取：看板数「今天几个番茄钟」只要今天的")
    void 记录按日期取() {
        long user = newUser("big_records");
        jdbc.update("INSERT INTO study_record(user_id, study_date, duration_minutes, note) VALUES (?, '2026-09-26', 25, 'a'), (?, '2026-09-27', 25, 'b'), (?, '2026-09-28', 25, 'c'), (?, '2026-09-28', 30, 'd')",
                user, user, user, user);
        LocalDate day = LocalDate.of(2026, 9, 28);
        List<StudyRecord> today = records.list(user, day, day);
        assertEquals(2, today.size());
        assertTrue(today.stream().allMatch(r -> r.getStudyDate().equals(day)));
        assertEquals(4, records.list(user, null, null).size(), "不给范围就是全部（别的调用方）");
        assertEquals(3, records.list(user, LocalDate.of(2026, 9, 27), null).size());
    }

    @Test
    @DisplayName("首页一周的数据：不再带没人读的 routineInstances / rangeTasks（和 days 里的重复）")
    void 首页不带重复数据() {
        long user = newUser("big_dash");
        createTasks(user, 5);
        jdbc.update("INSERT INTO study_routine(user_id, title, frequency, start_date, duration_minutes, reminder_offsets, days_of_week) VALUES (?, '背单词', 'DAILY', '2026-09-01', 30, '[0,60]', '[1,2,3]')", user);
        LocalDate day = LocalDate.of(2026, 9, 28);
        Map<String, Object> out = dashboard.build(user, day, day.plusDays(6), day, List.of());
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> days = (List<Map<String, Object>>) out.get("days");
        @SuppressWarnings("unchecked")
        Map<String, Object> routineItem = ((List<Map<String, Object>>) days.get(0).get("items")).stream()
                .filter(i -> "ROUTINE".equals(i.get("kind"))).findFirst().orElseThrow();
        for (String used : List.of("id", "kind", "title", "time", "completed")) {
            assertTrue(routineItem.containsKey(used), "页面要用的 " + used + " 没了：" + routineItem.keySet());
        }
        assertTrue(routineItem.size() <= 12, "一条例行计划带了 " + routineItem.size() + " 项：" + routineItem.keySet());
        assertFalse(routineItem.containsKey("reminderOffsets") || routineItem.containsKey("daysOfWeek"), "页面不用的也原样塞进来了：" + routineItem.keySet());
        assertTrue(out.containsKey("days") && out.containsKey("quadrants") && out.containsKey("upcomingDeadlines"));
        assertFalse(out.containsKey("routineInstances"), "routineInstances 页面从不读，内容和 days 里的一样");
        assertFalse(out.containsKey("rangeTasks"), "rangeTasks 页面从不读");
    }
}
