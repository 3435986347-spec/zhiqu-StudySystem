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

import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.Statement;
import java.time.LocalDateTime;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
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
    @Autowired private DataSource dataSource;
    @Autowired private StreamLiveness liveness;
    @Autowired private com.zhiqu.service.concurrency.ScheduledJobClaims claims;

    private long insert(String sql, Object... args) {
        jdbc.update(sql, args);
        return jdbc.queryForObject("SELECT LAST_INSERT_ID()", Long.class);
    }

    private Map<String, Object> row(String table, long id) {
        return jdbc.queryForMap("SELECT * FROM " + table + " WHERE id = ?", id);
    }

    @Test
    @DisplayName("心跳停了的（没有心跳的旧行按建立时间算）：回答（有半截 / 一个字没有）改成 ERROR 并说清原因、半截留着；执行记录、步骤、正在跑的任务 ERROR，没轮到的 SKIPPED；刚建的不碰")
    void 收拾上一个进程留下的() throws Exception {
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
        recovery.lastRun().get(30, TimeUnit.SECONDS);

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

    /**
     * 好几个后端连同一个库（第二十八轮；用户的部署：桌面应用和网页端连同一个远程 MySQL）。另一个进程正在生成的回答 ——
     * 早就建了、但心跳还在跳 —— 不许被收；心跳停了 3 分钟以上的才收。原来按「这个进程启动之前建的」收，
     * 桌面应用一启动，服务器上正在生成的回答就成了「服务在回答途中重启了」。
     */
    @Test
    @DisplayName("别的进程正在做的（早建了、心跳还在跳）不收；心跳停了的收，连同它下面的步骤和任务")
    void 看心跳不看启动时间() throws Exception {
        LocalDateTime longAgo = LocalDateTime.now().minusMinutes(20);
        long user = insert("INSERT INTO sys_user(username,password,nickname,role,deleted) VALUES('recovery-beat','x','r','USER',0)");
        long conv = insert("INSERT INTO ai_conversation(user_id) VALUES(?)", user);
        long alive = insert("INSERT INTO ai_message(user_id,conversation_id,role,content,status,created_at,heartbeat_at,deleted) VALUES(?,?,'assistant','别的进程正在说','STREAMING',?,NOW(),0)", user, conv, longAgo);
        long dead = insert("INSERT INTO ai_message(user_id,conversation_id,role,content,status,created_at,heartbeat_at,deleted) VALUES(?,?,'assistant','说到一半没了','STREAMING',?,NOW() - INTERVAL 5 MINUTE,0)", user, conv, longAgo);
        long aliveRun = insert("INSERT INTO ai_agent_run(user_id,status,created_at,heartbeat_at) VALUES(?,'RUNNING',?,NOW())", user, longAgo);
        long aliveStep = insert("INSERT INTO ai_agent_step(run_id,agent_type,step_order,status,created_at) VALUES(?,'CHAT',1,'RUNNING',?)", aliveRun, longAgo);
        long aliveTask = insert("INSERT INTO ai_agent_task(run_id,agent_type,task_type,status,created_at) VALUES(?,'CHAT','ANSWER','PENDING',?)", aliveRun, longAgo);
        long deadRun = insert("INSERT INTO ai_agent_run(user_id,status,created_at,heartbeat_at) VALUES(?,'RUNNING',?,NOW() - INTERVAL 5 MINUTE)", user, longAgo);
        long deadStep = insert("INSERT INTO ai_agent_step(run_id,agent_type,step_order,status,created_at) VALUES(?,'CHAT',1,'RUNNING',?)", deadRun, longAgo);

        recovery.recover();

        assertEquals("STREAMING", row("ai_message", alive).get("status"), "心跳还在跳的回答属于一个活着的进程，不许收");
        assertEquals("ERROR", row("ai_message", dead).get("status"));
        assertEquals("RUNNING", row("ai_agent_run", aliveRun).get("status"));
        assertEquals("RUNNING", row("ai_agent_step", aliveStep).get("status"), "活着的执行记录下面的步骤不许收");
        assertEquals("PENDING", row("ai_agent_task", aliveTask).get("status"), "活着的执行记录下面没轮到的任务不许收");
        assertEquals("ERROR", row("ai_agent_run", deadRun).get("status"));
        assertEquals("ERROR", row("ai_agent_step", deadStep).get("status"), "心跳停了的执行记录，它下面的步骤跟着收");
    }

    @Test
    @DisplayName("心跳：开始就碰一次（用数据库的钟）、只碰还在进行中的、停了就不再碰；每 2 分钟一趟的收拾接上了定时")
    void 心跳() throws Exception {
        long user = insert("INSERT INTO sys_user(username,password,nickname,role,deleted) VALUES('recovery-lease','x','r','USER',0)");
        long conv = insert("INSERT INTO ai_conversation(user_id) VALUES(?)", user);
        long msg = insert("INSERT INTO ai_message(user_id,conversation_id,role,content,status,deleted) VALUES(?,?,'assistant','','STREAMING',0)", user, conv);
        long run = insert("INSERT INTO ai_agent_run(user_id,status) VALUES(?,'RUNNING')", user);
        long finished = insert("INSERT INTO ai_message(user_id,conversation_id,role,content,status,deleted) VALUES(?,?,'assistant','完','DONE',0)", user, conv);
        try (StreamLiveness.Lease lease = liveness.hold(msg, run)) {
            assertTrue(row("ai_message", msg).get("heartbeat_at") != null, "hold() 一返回就该已经碰过一次心跳（当场碰，不等定时线程）");
            assertTrue(row("ai_agent_run", run).get("heartbeat_at") != null, "执行记录也要有心跳");
        }
        liveness.touch(finished, null);
        assertTrue(row("ai_message", finished).get("heartbeat_at") == null, "已经结束的回答不该再被碰心跳");
        assertTrue(InterruptedWorkRecovery.class.getMethod("sweep").isAnnotationPresent(org.springframework.scheduling.annotation.Scheduled.class),
                "收拾要定时跑：别的进程没了、又不再启动的那一份遗留，只能由还活着的实例收");
    }

    @Test
    @DisplayName("一天一次的定时任务按天认领：同一天第二个实例认领不到，换一天又能认领")
    void 按天认领() {
        String day = "2099-01-0" + (System.nanoTime() % 9 + 1);
        assertTrue(claims.claim("daily-reminder-test", day), "第一个实例认领到");
        assertFalse(claims.claim("daily-reminder-test", day), "同一天的第二个实例不该再发一遍");
        assertTrue(claims.claim("daily-reminder-test", day + "x"), "换一天照常");
    }

    @Test
    @DisplayName("收拾那一趟不挡启动：它的 UPDATE 被别的事务的行锁卡住时，启动照样往下走；锁放了它自己收完")
    void 不挡启动() throws Exception {
        LocalDateTime before = LocalDateTime.now().minusMinutes(5);
        long user = insert("INSERT INTO sys_user(username,password,nickname,role,deleted) VALUES('recovery-lock','x','r','USER',0)");
        long conv = insert("INSERT INTO ai_conversation(user_id) VALUES(?)", user);
        long stuck = insert("INSERT INTO ai_message(user_id,conversation_id,role,content,status,created_at,deleted) VALUES(?,?,'assistant','半句','STREAMING',?,0)", user, conv, before);
        // 大库上整表扫要好几秒、锁等待能等五十秒 —— 用一把真的行锁演「这一趟很慢」
        try (Connection holder = dataSource.getConnection()) {
            holder.setAutoCommit(false);
            try (Statement st = holder.createStatement()) {
                st.executeUpdate("UPDATE ai_message SET content = content WHERE id = " + stuck);
            }
            long t0 = System.nanoTime();
            recovery.run(null);
            long ms = (System.nanoTime() - t0) / 1_000_000;
            assertTrue(ms < 2000, "启动等着收拾那一趟等了 " + ms + "ms —— 大库上这就是服务晚起来的那几秒，出错时是起不来");
            assertFalse(recovery.lastRun().isDone(), "行锁还攥着，它不该已经收完了");
            holder.commit();
        }
        recovery.lastRun().get(30, TimeUnit.SECONDS);
        assertEquals("ERROR", row("ai_message", stuck).get("status"), "锁放了之后它自己收完");
    }
}
