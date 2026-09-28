package com.zhiqu.service.support;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfSystemProperty;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.time.LocalDateTime;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 服务半路重启之后，上一个进程没做完的事收成失败（第二十二轮）—— 真库、真 SQL。
 *
 * <p>真的 kill -9 实测：流式回答进行到一半时进程没了，重启之后那条回答在库里是 STREAMING、执行记录 / 步骤 / 任务是 RUNNING，
 * 页面上「还在等模型开始回答（已等 88 秒）」一直数下去。这里在库里摆出那副样子（建于这个进程启动之前），再摆一条「启动之后才建的」
 * 正在流的回答 —— 它不能被碰。
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "app.cookie.secure=false",
        "app.rag.enabled=false"
})
class InterruptedWorkRecoveryIntegrationTest {

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_recovery_test")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @Autowired private JdbcTemplate jdbc;
    @Autowired private InterruptedWorkRecovery recovery;

    private long insert(String sql, Object... args) {
        jdbc.update(sql, args);
        return jdbc.queryForObject("SELECT LAST_INSERT_ID()", Long.class);
    }

    private Map<String, Object> row(String table, long id) {
        return jdbc.queryForMap("SELECT * FROM " + table + " WHERE id = ?", id);
    }

    @Test
    @DisplayName("启动之前留下的：回答（有半截 / 一个字没有）改成 ERROR 并说清原因、半截留着；执行记录、步骤、正在跑的任务 ERROR，没轮到的 SKIPPED；启动之后建的不碰")
    void 收拾上一个进程留下的() {
        LocalDateTime before = LocalDateTime.now().minusMinutes(5);
        LocalDateTime after = LocalDateTime.now().plusMinutes(5);   // 「这个进程启动之后才建的」
        long user = insert("INSERT INTO sys_user(username,password,nickname,role,deleted) VALUES('recovery','x','r','USER',0)");
        long conv = insert("INSERT INTO ai_conversation(user_id) VALUES(?)", user);

        long partial = insert("INSERT INTO ai_message(user_id,conversation_id,role,content,status,created_at,deleted) VALUES(?,?,'assistant','第1段。第2段。','STREAMING',?,0)", user, conv, before);
        long empty = insert("INSERT INTO ai_message(user_id,conversation_id,role,content,status,created_at,deleted) VALUES(?,?,'assistant','','STREAMING',?,0)", user, conv, before);
        long live = insert("INSERT INTO ai_message(user_id,conversation_id,role,content,status,created_at,deleted) VALUES(?,?,'assistant','正在说','STREAMING',?,0)", user, conv, after);
        long done = insert("INSERT INTO ai_message(user_id,conversation_id,role,content,status,created_at,deleted) VALUES(?,?,'assistant','说完了','DONE',?,0)", user, conv, before);

        long run = insert("INSERT INTO ai_agent_run(user_id,status,created_at) VALUES(?,'RUNNING',?)", user, before);
        long liveRun = insert("INSERT INTO ai_agent_run(user_id,status,created_at) VALUES(?,'RUNNING',?)", user, after);
        long step = insert("INSERT INTO ai_agent_step(run_id,agent_type,step_order,status,created_at) VALUES(?,'CHAT',1,'RUNNING',?)", run, before);
        long running = insert("INSERT INTO ai_agent_task(run_id,agent_type,task_type,status,created_at) VALUES(?,'CHAT','ANSWER','RUNNING',?)", run, before);
        long waiting = insert("INSERT INTO ai_agent_task(run_id,agent_type,task_type,status,created_at) VALUES(?,'CHAT','VERIFY','PENDING',?)", run, before);

        // 走启动时的那个入口（ApplicationRunner）：只测 recover() 的话，启动时没接上也是绿的
        assertTrue(recovery instanceof ApplicationRunner, "启动时要跑：得是 ApplicationRunner");
        recovery.run(null);

        assertEquals("ERROR", row("ai_message", partial).get("status"));
        assertEquals("第1段。第2段。", row("ai_message", partial).get("content"), "已经落库的半截留着");
        assertEquals(InterruptedWorkRecovery.ANSWER_REASON, row("ai_message", partial).get("error_message"));
        assertEquals("ERROR", row("ai_message", empty).get("status"));
        assertEquals(InterruptedWorkRecovery.ANSWER_REASON_EMPTY, row("ai_message", empty).get("error_message"),
                "一个字都没有时不能说「已经收到的部分留着」");
        assertEquals("STREAMING", row("ai_message", live).get("status"), "启动之后才开始的回答不能碰");
        assertEquals("DONE", row("ai_message", done).get("status"));

        assertEquals("ERROR", row("ai_agent_run", run).get("status"));
        assertEquals("RUNNING", row("ai_agent_run", liveRun).get("status"));
        assertEquals("ERROR", row("ai_agent_step", step).get("status"));
        assertEquals("ERROR", row("ai_agent_task", running).get("status"));
        assertEquals("SKIPPED", row("ai_agent_task", waiting).get("status"));

        assertArrayEquals(new int[]{0, 0, 0, 0}, recovery.recover(), "再跑一遍什么都不改");
    }
}
