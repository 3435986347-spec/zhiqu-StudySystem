package com.zhiqu.service.impl;

import com.zhiqu.common.BusinessClock;
import com.zhiqu.dto.TaskCreateRequest;
import com.zhiqu.entity.StudyTask;
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

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * 页面里的提醒要的那份清单（{@code GET /api/reminder/upcoming}，第二十五轮）—— 真 MySQL、任务走真的建任务服务（标题是加密存的）。
 *
 * <p>给页面的是「接下来 24 小时 + 刚过去 15 分钟」的任务提醒，标题解密好；已跳过的（任务完成、提醒重排时取消的）和
 * 已完成任务的不给；**不看第三方渠道发没发出去** —— 没配渠道的人（第二十三轮走主流程看到：到点记一条「提醒渠道未启用」就没了）
 * 正是最需要页面里提醒的人。
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "app.cookie.secure=false",
        "app.rag.enabled=false"
})
class UpcomingRemindersIntegrationTest {

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_upcoming_test")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @Autowired private JdbcTemplate jdbc;
    @Autowired private ReminderServiceImpl reminders;
    @Autowired private StudyTaskService tasks;
    @Autowired private BusinessClock clock;

    @Test
    @DisplayName("接下来 24 小时 + 刚过去 15 分钟的任务提醒、标题解密；跳过的、已完成任务的、太远的、太久以前的、别人的不给；渠道没发出去的照给")
    void 页面要的提醒清单() {
        long me = user("upcoming-me"), other = user("upcoming-other");
        LocalDateTime now = clock.now();
        StudyTask soon = task(me, "给财务发发票", now.plusHours(2));
        StudyTask farAway = task(me, "下下周的事", now.plusHours(30));
        StudyTask done = task(me, "已经做完的", now.plusHours(3));
        tasks.updateStatus(me, done.getId(), 2);                 // 完成：提醒被跳过
        StudyTask missed = task(me, "刚错过的", null);
        long justNow = reminder(me, missed.getId(), now.minusMinutes(5), "FAILED");     // 没配渠道，到点记了失败
        reminder(me, missed.getId(), now.minusMinutes(40), "SENT");                     // 太久以前
        task(other, "别人的", now.plusHours(1));
        // 下面两条各管一道，不许互相替对方挡（第一版两道各删一道都没红 —— 完成任务时提醒同时被跳过，两道条件同时成立）：
        // 改过提醒时间的未完成任务：旧提醒被跳过（不该给）、新的照给 —— 只有「跳过的不给」管得着
        StudyTask moved = tasks.detail(me, task(me, "改过时间的", now.plusHours(1)).getId());   // 从库里读：要带版本号
        moved.setReminderTime(now.plusHours(5).withNano(0));   // DATETIME 存的时候四舍五入到秒
        tasks.update(me, moved.getId(), updateOf(moved));
        // 刚提醒过（没发出去）、然后做完了的任务：提醒不是「跳过」（完成只取消还在排队的），只有「完成了不给」管得着
        StudyTask finishedAfter = task(me, "提醒过才做完的", null);
        reminder(me, finishedAfter.getId(), now.minusMinutes(3), "FAILED");
        tasks.updateStatus(me, finishedAfter.getId(), 2);

        List<Map<String, Object>> got = reminders.upcoming(me, now);
        assertEquals(List.of("刚错过的", "给财务发发票", "改过时间的"), got.stream().map(r -> (String) r.get("title")).toList(),
                "清单不对：" + got);
        assertEquals(justNow, ((Number) got.get(0).get("id")).longValue());
        assertEquals("CUSTOM", got.get(1).get("type"));
        assertEquals(soon.getId(), ((Number) got.get(1).get("taskId")).longValue());
        assertEquals(now.plusHours(5).withNano(0), got.get(2).get("scheduledAt"), "改过时间的要给新的时间");
    }

    private static com.zhiqu.dto.TaskUpdateRequest updateOf(StudyTask t) {
        com.zhiqu.dto.TaskUpdateRequest u = new com.zhiqu.dto.TaskUpdateRequest();
        u.setTitle(t.getTitle());
        u.setQuadrant(t.getQuadrant());
        u.setReminderTime(t.getReminderTime());
        u.setReminderOffsets(List.of());
        u.setVersion(t.getVersion());
        return u;
    }

    private long user(String name) {
        jdbc.update("INSERT INTO sys_user(username,password,nickname,role,deleted) VALUES(?,?,?, 'USER',0)", name, "x", name);
        return jdbc.queryForObject("SELECT id FROM sys_user WHERE username=?", Long.class, name);
    }

    private StudyTask task(long userId, String title, LocalDateTime reminderTime) {
        TaskCreateRequest r = new TaskCreateRequest();
        r.setTitle(title);
        r.setQuadrant(2);
        r.setReminderTime(reminderTime);
        r.setReminderOffsets(List.of());
        return tasks.create(userId, r);
    }

    private long reminder(long userId, long taskId, LocalDateTime at, String status) {
        jdbc.update("INSERT INTO task_reminder(user_id,task_id,reminder_type,scheduled_at,status,deleted) VALUES(?,?,'CUSTOM',?,?,0)",
                userId, taskId, at, status);
        return jdbc.queryForObject("SELECT MAX(id) FROM task_reminder", Long.class);
    }
}
