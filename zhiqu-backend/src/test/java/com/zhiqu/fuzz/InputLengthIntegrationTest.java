package com.zhiqu.fuzz;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

/**
 * 每个有长度上限的字段<b>单独</b>超长一次（第十一轮）。
 *
 * <p>为什么不能只靠 {@code EndpointFuzzIntegrationTest}：它把一个请求的所有字段同时灌成超长，于是只有<b>最先</b>拦下来的那一道
 * 被测到 —— 扰动时拿掉用户名的长度上限照样绿，因为密码的 72 字节规则先把请求拒了。多道校验同时在场时，一道替另一道挡着，
 * 删掉哪一道判据都看不出来。所以这里一次只让一个字段超长，其余都合法，断言拒绝理由说的正是这个字段、而且没有落进兜底分支。
 */
@Testcontainers
@AutoConfigureMockMvc
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "app.cookie.secure=false",
        "app.rag.enabled=false"
})
class InputLengthIntegrationTest {

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_lengths")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @Autowired private MockMvc mvc;
    @Autowired private JdbcTemplate jdbc;
    @Autowired private JwtUtils jwt;
    @Autowired private ObjectMapper json;

    private static final AtomicInteger PEER = new AtomicInteger(1);

    private JsonNode call(MockHttpServletRequestBuilder req, Map<String, Object> body, String token) throws Exception {
        int n = PEER.incrementAndGet();
        req.contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body))
                .with(r -> { r.setRemoteAddr("192.0." + (n / 250) + "." + (n % 250 + 1)); return r; });
        if (token != null) {
            req.header("Authorization", "Bearer " + token);
        }
        return json.readTree(mvc.perform(req).andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8));
    }

    private void rejected(JsonNode r, String expected) {
        assertTrue(r.path("code").asInt() != 200, "超长也收了：" + r);
        assertTrue(r.path("message").asText().contains(expected), "拒绝理由没说到这个字段：" + r);
        Integer server = jdbc.queryForObject("SELECT COUNT(*) FROM runtime_issue WHERE source = 'SERVER'", Integer.class);
        assertEquals(0, server, "落进了兜底分支（记成了运行问题）：" + r);
    }

    private String token() {
        jdbc.update("INSERT IGNORE INTO sys_user(username, password, nickname, role, status, deleted) VALUES ('len', 'x', 'len', 'USER', 1, 0)");
        Long id = jdbc.queryForObject("SELECT id FROM sys_user WHERE username = 'len'", Long.class);
        return jwt.generateToken(id, "len", 0, 3_600_000L);
    }

    @Test
    @DisplayName("注册：只有用户名超长（密码合法）→ 说用户名最长 50")
    void 用户名() throws Exception {
        rejected(call(post("/api/auth/register"), Map.of("username", "u".repeat(51), "password", "ok-pass-123",
                "confirmPassword", "ok-pass-123"), null), "用户名最长 50");
    }

    @Test
    @DisplayName("个人资料：昵称 / 学校 / 专业 / 邮箱各自单独超长 → 各说各的")
    void 个人资料() throws Exception {
        String token = token();
        Map<String, Integer> limits = Map.of("nickname", 50, "school", 100, "major", 100, "email", 120);
        Map<String, String> names = Map.of("nickname", "昵称", "school", "学校", "major", "专业", "email", "邮箱");
        for (Map.Entry<String, Integer> e : limits.entrySet()) {
            Map<String, Object> body = new LinkedHashMap<>(Map.of("nickname", "好名字", "school", "某大学", "major", "计算机", "email", "a@b.c"));
            body.put(e.getKey(), "字".repeat(e.getValue() + 1));
            rejected(call(put("/api/user/profile"), body, token), names.get(e.getKey()) + "最长 " + e.getValue());
        }
    }

    @Test
    @DisplayName("例行计划：标题 / 说明 / 类型各自单独超长 → 各说各的")
    void 例行计划() throws Exception {
        String token = token();
        Object[][] cases = {{"title", 200, "例行计划标题最长 200"}, {"description", 2000, "例行计划说明最长 2000"}, {"taskType", 50, "任务类型最长 50"}};
        for (Object[] c : cases) {
            Map<String, Object> body = new LinkedHashMap<>(Map.of("title", "每天背单词", "description", "早上", "taskType", "study"));
            body.put((String) c[0], "字".repeat((Integer) c[1] + 1));
            rejected(call(post("/api/routine"), body, token), (String) c[2]);
        }
    }
}
