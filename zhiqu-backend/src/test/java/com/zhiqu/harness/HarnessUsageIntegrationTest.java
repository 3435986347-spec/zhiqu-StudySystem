package com.zhiqu.harness;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessClock;
import com.zhiqu.security.JwtUtils;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfSystemProperty;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.time.LocalTime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * 命令行用量里的缓存命中数（第九十三轮）：V46 给 harness_usage 加了可空的 cached_tokens，/api/harness/usage 的合计带上它。
 * 在真库上跑（迁移真的执行过）：列不存在时合计那条 SQL 直接报错，单元测试里的假 mapper 照不出来。
 */
@Testcontainers
@AutoConfigureMockMvc
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "app.cookie.secure=false",
        "app.rag.enabled=false"
})
class HarnessUsageIntegrationTest {

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_usage")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @Autowired private MockMvc mvc;
    @Autowired private JdbcTemplate jdbc;
    @Autowired private JwtUtils jwt;
    @Autowired private ObjectMapper json;
    @Autowired private BusinessClock clock;

    private void usage(Long user, LocalDateTime at, int prompt, int completion, Integer cached) {
        jdbc.update("INSERT INTO harness_usage(user_id, model_name, prompt_tokens, completion_tokens, cached_tokens, estimated, created_at) "
                + "VALUES (?, 'deepseek-v4-pro', ?, ?, ?, 0, ?)", user, prompt, completion, cached, at);
    }

    @Test
    @DisplayName("今天的合计带缓存命中数：命中的加起来，没报的（NULL）不算命中；四十天前的不算")
    void 今天的缓存命中() throws Exception {
        jdbc.update("INSERT INTO sys_user(username, password, nickname, role, status, deleted) VALUES ('usage-me', 'x', 'usage-me', 'USER', 1, 0)");
        Long me = jdbc.queryForObject("SELECT id FROM sys_user WHERE username = 'usage-me'", Long.class);
        LocalDateTime noon = LocalDateTime.of(clock.today(), LocalTime.NOON);
        usage(me, noon, 3000, 10, 2816);
        usage(me, noon, 500, 5, null);
        usage(me, noon.minusDays(40), 9000, 9, 9000);

        String token = jwt.generateToken(me, "usage-me", 0, 3_600_000L);
        JsonNode r = json.readTree(mvc.perform(get("/api/harness/usage").header("Authorization", "Bearer " + token)
                .with(req -> { req.setRemoteAddr("100.64.9.9"); return req; }))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8));
        assertEquals(200, r.path("code").asInt(), r.toString());
        JsonNode today = r.path("data").path("today");
        assertEquals(2, today.path("calls").asInt(), r.toString());
        assertEquals(3500, today.path("promptTokens").asInt());
        assertEquals(2816, today.path("cachedTokens").asInt(), "今天命中的只有第一条：" + today);
        assertEquals(2816, r.path("data").path("last30Days").path("cachedTokens").asInt(), "四十天前那条不算进近 30 天");
    }
}
