package com.zhiqu.harness;

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
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

/**
 * 命令行 /window：给自己的模型设上下文窗口（第十二轮）。用户的 DeepSeek V4 Pro 有 1M 上下文，命令行却按 64000 算、压缩两次 ——
 * 那个模型配置里没填窗口。网页「模型设置」里能填，命令行里现在也能：只改窗口这一列，只能改自己的，范围和网页同一个校验。
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
class ContextWindowIntegrationTest {

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_window")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @Autowired private MockMvc mvc;
    @Autowired private JdbcTemplate jdbc;
    @Autowired private JwtUtils jwt;
    @Autowired private ObjectMapper json;

    private static final AtomicInteger PEER = new AtomicInteger(1);

    private JsonNode call(MockHttpServletRequestBuilder req, String token) throws Exception {
        int n = PEER.incrementAndGet();
        req.header("Authorization", "Bearer " + token)
                .with(r -> { r.setRemoteAddr("100.64." + (n / 250) + "." + (n % 250 + 1)); return r; });
        return json.readTree(mvc.perform(req).andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8));
    }

    private JsonNode setWindow(String token, long modelId, Object tokens) throws Exception {
        return call(post("/api/harness/models/" + modelId + "/context-window").contentType(MediaType.APPLICATION_JSON)
                .content("{\"tokens\":" + json.writeValueAsString(tokens) + "}"), token);
    }

    private Long user(String name) {
        jdbc.update("INSERT INTO sys_user(username, password, nickname, role, status, deleted) VALUES (?, 'x', ?, 'USER', 1, 0)", name, name);
        return jdbc.queryForObject("SELECT id FROM sys_user WHERE username = ?", Long.class, name);
    }

    private Long model(Long owner, String ownerType) {
        jdbc.update("INSERT INTO ai_model_config(user_id, owner_type, provider_type, display_name, api_url, model_name, enabled, is_default, deleted) "
                + "VALUES (?, ?, 'OPENAI_COMPATIBLE', 'DeepseekV4pro', 'https://api.deepseek.com/v1/chat/completions', 'deepseek-v4-pro', 1, 0, 0)", owner, ownerType);
        return jdbc.queryForObject("SELECT MAX(id) FROM ai_model_config", Long.class);
    }

    private Integer windowOf(long modelId) {
        return jdbc.queryForObject("SELECT context_window_tokens FROM ai_model_config WHERE id = ?", Integer.class, modelId);
    }

    @Test
    @DisplayName("自己的模型：设 1M → 库里是 1000000，命令行拿到的模型列表里 effectiveContextWindow 跟着变")
    void 设自己的模型() throws Exception {
        Long me = user("win-me");
        String token = jwt.generateToken(me, "win-me", 0, 3_600_000L);
        Long mine = model(me, "USER");
        assertNull(windowOf(mine));
        JsonNode r = setWindow(token, mine, 1_000_000);
        assertEquals(200, r.path("code").asInt(), r.toString());
        assertEquals(1_000_000, r.path("data").path("effectiveContextWindow").asInt());
        assertEquals(1_000_000, windowOf(mine));
        JsonNode models = call(get("/api/harness/models"), token);
        boolean seen = false;
        for (JsonNode m : models.path("data").path("models")) {
            if (m.path("id").asLong() == mine) {
                assertEquals(1_000_000, m.path("effectiveContextWindow").asInt());
                seen = true;
            }
        }
        assertTrue(seen, "模型列表里找不到它：" + models);
    }

    @Test
    @DisplayName("别人的模型、系统模型：不许改（库里不动）；超出 8000–1000000、不是数字：拒绝并说范围")
    void 只能改自己的() throws Exception {
        Long me = user("win-a");
        Long other = user("win-b");
        String token = jwt.generateToken(me, "win-a", 0, 3_600_000L);
        Long theirs = model(other, "USER");
        Long system = model(null, "SYSTEM");
        Long mine = model(me, "USER");
        assertTrue(setWindow(token, theirs, 1_000_000).path("code").asInt() != 200);
        assertNull(windowOf(theirs), "改到了别人的模型");
        assertTrue(setWindow(token, system, 1_000_000).path("code").asInt() != 200);
        assertNull(windowOf(system), "普通用户改到了系统模型");
        // 系统类型、但 user_id 恰好是自己（管理员在网页后台建的那种）：命令行也不许改 —— 只认 owner_type=USER
        Long systemButMine = model(me, "SYSTEM");
        assertTrue(setWindow(token, systemButMine, 1_000_000).path("code").asInt() != 200);
        assertNull(windowOf(systemButMine), "命令行改到了系统类型的模型");
        for (Object bad : new Object[]{5000, 2_000_000, "1m"}) {
            JsonNode r = setWindow(token, mine, bad);
            assertTrue(r.path("code").asInt() != 200 && r.path("message").asText().contains("8000"), bad + " → " + r);
        }
        assertNull(windowOf(mine));
    }
}
