package com.zhiqu.service.impl;

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

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * 中断在 PROCESSING 的提醒怎么收回来 —— 真 SQL、真 MySQL。
 *
 * <p>两条语句的顺序是这里真正要钉的：先把「重排过一次又中断」的判死，再把第一次中断的放回队列。
 * 反过来的话，重排过的那些会被再放回队列 —— 永远不放弃，每小时把同一条提醒重发一遍。
 * 时间比较全在数据库那一侧（{@code NOW() - INTERVAL}），和 {@code claimPending} 写 {@code updated_at} 同一个时钟。
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "spring.task.scheduling.enabled=false",
        "app.cookie.secure=false",
        "app.rag.enabled=false"
})
class ReminderRecoveryIntegrationTest {

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_reminder_test")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @Autowired private JdbcTemplate jdbc;
    @Autowired private ReminderServiceImpl reminders;

    @Test
    @DisplayName("第一次中断放回队列、第二次中断判死；没过期的、已删除的、本来就在排队的都不动")
    void 收回中断的提醒() {
        jdbc.update("INSERT INTO sys_user(username,password,nickname,role,deleted) VALUES('reminder-recovery','x','r','USER',0)");
        long user = jdbc.queryForObject("SELECT id FROM sys_user WHERE username='reminder-recovery'", Long.class);
        jdbc.update("INSERT INTO study_task(user_id,title,quadrant) VALUES(?,?,1)", user, "t");
        long task = jdbc.queryForObject("SELECT MAX(id) FROM study_task WHERE user_id=?", Long.class, user);

        long firstTime = row(user, task, "PROCESSING", null, 120, 0);
        long secondTime = row(user, task, "PROCESSING", ReminderServiceImpl.REQUEUED_MARKER, 120, 0);
        long stillWorking = row(user, task, "PROCESSING", null, 5, 0);
        long deleted = row(user, task, "PROCESSING", null, 120, 1);
        long queued = row(user, task, "PENDING", null, 120, 0);

        assertEquals(2, reminders.recoverInterrupted());

        assertEquals("PENDING", status(firstTime), "第一次中断应当放回队列");
        assertEquals(ReminderServiceImpl.REQUEUED_MARKER, reason(firstTime));
        assertEquals("FAILED", status(secondTime), "重排过一次又中断，不该再重试");
        assertEquals(ReminderServiceImpl.GAVE_UP_REASON, reason(secondTime));
        assertEquals("PROCESSING", status(stillWorking), "还在正常处理时间内的不能动");
        assertEquals("PROCESSING", status(deleted), "已删除的不动");
        assertEquals("PENDING", status(queued));
        assertNull(reason(queued));

        assertEquals(0, reminders.recoverInterrupted(), "收回之后再跑一遍应当什么都不做");
    }

    private long row(long user, long task, String status, String reason, int minutesAgo, int deleted) {
        jdbc.update("INSERT INTO task_reminder(user_id,task_id,offset_days,reminder_type,scheduled_at,status,failure_reason,updated_at,deleted) "
                        + "VALUES(?,?,1,'AUTO',NOW(),?,?,NOW() - INTERVAL ? MINUTE,?)",
                user, task, status, reason, minutesAgo, deleted);
        return jdbc.queryForObject("SELECT MAX(id) FROM task_reminder", Long.class);
    }

    private String status(long id) {
        return (String) one(id).get("status");
    }

    private String reason(long id) {
        return (String) one(id).get("failure_reason");
    }

    private Map<String, Object> one(long id) {
        return jdbc.queryForMap("SELECT status, failure_reason FROM task_reminder WHERE id=?", id);
    }
}
