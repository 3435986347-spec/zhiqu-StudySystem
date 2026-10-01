package com.zhiqu.service.impl;

import com.zhiqu.mapper.SharedPlanTemplateMapper;
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

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * 参考计划的两个计数，真 SQL、真 MySQL：只改自己那一列（状态被管理员改过也不会被改回去）、并发不丢、
 * 点赞数按点赞表重数（软删除的不算）。
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "app.cookie.secure=false",
        "app.rag.enabled=false"
})
class SharedPlanCountersIntegrationTest {

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_shared_plan_test")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @Autowired private JdbcTemplate jdbc;
    @Autowired private SharedPlanTemplateMapper templates;
    @Autowired private com.zhiqu.service.SharedPlanService sharedPlans;

    @Test
    @DisplayName("列表里的「我点过没有」只算我自己的赞：批量查点赞时漏了 user_id，别人的赞就成了我的")
    void 只算自己的赞() {
        long owner = user("plan-owner-3");
        long me = user("liker-me");
        long other = user("liker-other");
        jdbc.update("INSERT INTO shared_plan_template(user_id,title,status,deleted) VALUES(?,?,'APPROVED',0)", owner, "我点过的");
        long mine = jdbc.queryForObject("SELECT MAX(id) FROM shared_plan_template", Long.class);
        jdbc.update("INSERT INTO shared_plan_template(user_id,title,status,deleted) VALUES(?,?,'APPROVED',0)", owner, "别人点过的");
        long theirs = jdbc.queryForObject("SELECT MAX(id) FROM shared_plan_template", Long.class);
        jdbc.update("INSERT INTO shared_plan_like(template_id,user_id,deleted) VALUES(?,?,0)", mine, me);
        jdbc.update("INSERT INTO shared_plan_like(template_id,user_id,deleted) VALUES(?,?,0)", theirs, other);

        Map<Long, Object> liked = new java.util.HashMap<>();
        for (Map<String, Object> row : sharedPlans.publicList(me, null, null, null)) {
            liked.put(((Number) row.get("id")).longValue(), row.get("liked"));
        }
        assertEquals(true, liked.get(mine));
        assertEquals(false, liked.get(theirs), "别人的赞算到了我头上");
    }

    private long user(String name) {
        jdbc.update("INSERT INTO sys_user(username,password,nickname,role,deleted) VALUES(?,'x','u','USER',0)", name);
        return jdbc.queryForObject("SELECT id FROM sys_user WHERE username=?", Long.class, name);
    }

    @Test
    @DisplayName("计数只改自己那一列：管理员刚驳回的计划，套用 / 点赞之后还是驳回；点赞数按点赞表重数，软删除的不算")
    void 只改计数列() {
        long owner = user("plan-owner");
        jdbc.update("INSERT INTO shared_plan_template(user_id,title,status,apply_count,like_count,deleted) VALUES(?,?,'APPROVED',0,0,0)", owner, "考研冲刺");
        long id = jdbc.queryForObject("SELECT MAX(id) FROM shared_plan_template", Long.class);
        jdbc.update("UPDATE shared_plan_template SET status='REJECTED', title='管理员改过的标题' WHERE id=?", id);
        for (int i = 0; i < 3; i++) {
            jdbc.update("INSERT INTO shared_plan_like(template_id,user_id,deleted) VALUES(?,?,?)", id, user("fan" + i), i == 2 ? 1 : 0);
        }

        templates.incrementApplyCount(id);
        templates.incrementApplyCount(id);
        templates.refreshLikeCount(id);

        Map<String, Object> row = jdbc.queryForMap("SELECT status,title,apply_count,like_count FROM shared_plan_template WHERE id=?", id);
        assertEquals("REJECTED", row.get("status"), "状态被计数的写入改回去了");
        assertEquals("管理员改过的标题", row.get("title"));
        assertEquals(2, ((Number) row.get("apply_count")).intValue());
        assertEquals(2, ((Number) row.get("like_count")).intValue(), "软删除的那个赞不该算");
    }

    @Test
    @DisplayName("并发套用：八个人同时套用，套用次数一次不丢")
    void 并发不丢() throws Exception {
        long owner = user("plan-owner-2");
        jdbc.update("INSERT INTO shared_plan_template(user_id,title,status,apply_count,deleted) VALUES(?,?,'APPROVED',NULL,0)", owner, "四级词汇");
        long id = jdbc.queryForObject("SELECT MAX(id) FROM shared_plan_template", Long.class);
        ExecutorService pool = Executors.newFixedThreadPool(8);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<?>> done = new ArrayList<>();
        for (int i = 0; i < 8; i++) {
            done.add(pool.submit(() -> {
                go.await();
                return templates.incrementApplyCount(id);
            }));
        }
        go.countDown();
        for (Future<?> f : done) {
            f.get();
        }
        pool.shutdown();
        assertEquals(8, jdbc.queryForObject("SELECT apply_count FROM shared_plan_template WHERE id=?", Integer.class, id),
                "apply_count 原来是 NULL 也要从 0 开始数");
    }
}
