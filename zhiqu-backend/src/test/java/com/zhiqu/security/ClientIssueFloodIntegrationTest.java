package com.zhiqu.security;

import com.zhiqu.security.JwtUtils;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfSystemProperty;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

/**
 * 客户端上报运行问题的接口（{@code POST /api/runtime-issue/client}）—— 第十一轮暴力测试查出来的：
 * 它在放行名单里（<b>不登录也能调</b>），不去重、不限量，每条最多 8000 字；而现在的页面根本不调它（只有没人加载的旧 js/common.js 调）。
 * 于是它唯一的实际用途，是让任何人往管理员后台的「运行问题」里灌垃圾。现在：要登录；同一个人 10 分钟内同一条只记一次；
 * 每人每小时最多 30 条。
 */
@Testcontainers
@AutoConfigureMockMvc
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "spring.task.scheduling.enabled=false",
        "app.cookie.secure=false",
        "app.rag.enabled=false"
})
class ClientIssueFloodIntegrationTest {

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_issue_flood")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @Autowired private MockMvc mvc;
    @Autowired private JdbcTemplate jdbc;
    @Autowired private JwtUtils jwt;

    private static final AtomicInteger PEER = new AtomicInteger(1);

    private MockHttpServletRequestBuilder report(String token, String message) {
        int n = PEER.incrementAndGet();
        MockHttpServletRequestBuilder req = post("/api/runtime-issue/client").contentType(MediaType.APPLICATION_JSON)
                .content("{\"message\":\"" + message + "\",\"category\":\"JS_RUNTIME\",\"detail\":\"" + "x".repeat(7000) + "\"}")
                .with(r -> { r.setRemoteAddr("198.51." + (n / 250) + "." + (n % 250 + 1)); return r; });
        return token == null ? req : req.header("Authorization", "Bearer " + token);
    }

    private int clientRows() {
        return jdbc.queryForObject("SELECT COUNT(*) FROM runtime_issue WHERE source = 'CLIENT'", Integer.class);
    }

    @Test
    @DisplayName("不登录不收；同一条 10 分钟内只记一次；每人每小时最多 30 条")
    void 不能拿来灌垃圾() throws Exception {
        for (int i = 0; i < 5; i++) {
            mvc.perform(report(null, "anon-" + i));
        }
        assertEquals(0, clientRows(), "不登录也能往运行问题里写");

        jdbc.update("INSERT INTO sys_user(username, password, nickname, role, status, deleted) VALUES ('flood', 'x', 'flood', 'USER', 1, 0)");
        Long id = jdbc.queryForObject("SELECT id FROM sys_user WHERE username = 'flood'", Long.class);
        String token = jwt.generateToken(id, "flood", 0, 3_600_000L);

        for (int i = 0; i < 20; i++) {
            mvc.perform(report(token, "同一个错误：x is undefined"));
        }
        assertEquals(1, clientRows(), "同一个错误刷新 20 次记了 " + clientRows() + " 条");

        for (int i = 0; i < 50; i++) {
            mvc.perform(report(token, "不同的错误 " + i));
        }
        int rows = clientRows();
        assertTrue(rows <= 30, "一小时里记了 " + rows + " 条 —— 没有上限");
        assertTrue(rows >= 25, "上限定得太低或者没收：" + rows);
    }
}
