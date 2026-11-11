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
import static org.junit.jupiter.api.Assertions.assertTrue;
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

    /**
     * 第一百二十八轮：命令行存到网站的那一份，每一步单独给（原来拼成「> 过程：…」接在回答后面，网页上渲染成乱码）。
     * 真接口、真库：照形状收（别人机器上来的）、running 收成没做完、存进 steps_json、网页的消息列表读得回来；正文不带过程那一行。
     */
    @Test
    @DisplayName("命令行存档带步骤：照形状收、存进 steps_json、消息列表读得回；坏的不收；截掉的步数照实存")
    void 命令行存档带步骤(@Autowired org.springframework.jdbc.core.JdbcTemplate db, @Autowired com.zhiqu.service.AiService ai) throws Exception {
        jdbc.update("INSERT INTO sys_user(username, password, nickname, role, status, deleted) VALUES ('archive-me', 'x', 'archive-me', 'USER', 1, 0)");
        Long me = jdbc.queryForObject("SELECT id FROM sys_user WHERE username = 'archive-me'", Long.class);
        String token = jwt.generateToken(me, "archive-me", 0, 3_600_000L);
        String body = json.writeValueAsString(java.util.Map.of("title", "做个游戏", "workspace", "game", "messages", java.util.List.of(
                java.util.Map.of("role", "user", "content", "做个游戏"),
                java.util.Map.of("role", "assistant", "content", "做好了", "stepsDropped", 37, "steps", java.util.List.of(
                        java.util.Map.of("id", "s1", "kind", "run", "title", "运行", "target", "npm test", "summary", "退出码 0", "status", "ok",
                                "detail", java.util.Map.of("command", "npm test", "exitCode", 0, "output", "ok 1", "evil", "x")),
                        java.util.Map.of("id", "s2", "kind", "create", "title", "新建", "target", "a.js", "status", "running"),
                        java.util.Map.of("kind", "read", "title", "没有 id"))))));
        JsonNode r = json.readTree(mvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post("/api/harness/sessions/cli-s1/messages")
                        .header("Authorization", "Bearer " + token).header("Idempotency-Key", java.util.UUID.randomUUID().toString())
                        .contentType("application/json").content(body)
                        .with(req -> { req.setRemoteAddr("100.64.9.9"); return req; }))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8));
        assertEquals(200, r.path("code").asInt(), r.toString());
        String raw = db.queryForObject("SELECT steps_json FROM ai_message WHERE user_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1", String.class, me);
        JsonNode steps = json.readTree(raw).path("steps");
        assertEquals(2, steps.size(), "没有 id 的那条要丢掉：" + raw);
        assertEquals("error", steps.get(1).path("status").asText(), "存档里停在 running 的要收成没做完");
        assertTrue(steps.get(0).path("detail").path("evil").isMissingNode(), "认不出的字段收了：" + raw);
        assertEquals(37, json.readTree(raw).path("dropped").asInt(), "命令行那边截掉的步数没存（网页上不会说「后面还有 N 步没存」）：" + raw);
        String content = db.queryForObject("SELECT content FROM ai_message WHERE user_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1", String.class, me);
        assertEquals("做好了", content);
        Long notebookId = db.queryForObject("SELECT notebook_id FROM harness_session WHERE user_id = ? LIMIT 1", Long.class, me);
        java.util.List<java.util.Map<String, Object>> rows = ai.getRecentChatMessages(me, notebookId, 10, null);
        assertTrue(rows.get(rows.size() - 1).get("steps") != null, "消息列表没带步骤：" + rows);
    }

    /** 一次请求成没成：HTTP 200 而且业务码 200（没登录时是 401 / 403，或者 200 + 业务码不是 200） */
    private JsonNode call(String method, String path, String token) throws Exception {
        org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder b =
                org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request(org.springframework.http.HttpMethod.valueOf(method), path)
                        .header("Authorization", "Bearer " + token).header("Idempotency-Key", java.util.UUID.randomUUID().toString())
                        .with(req -> { req.setRemoteAddr("100.64.9.9"); return req; });
        org.springframework.mock.web.MockHttpServletResponse r = mvc.perform(b).andReturn().getResponse();
        String text = r.getContentAsString(StandardCharsets.UTF_8);
        if (r.getStatus() != 200 || text.isBlank()) return null;
        JsonNode body = json.readTree(text);
        return body.path("code").asInt() == 200 ? body : null;
    }

    /**
     * 第一百二十九轮：桌面版本机代码助手的令牌。真接口、真库：网页的登录态签一张 → 本机代码要的接口认、别的 harness 接口不认、
     * 令牌换不来令牌 → 过了期限就不认、设置里的列表也不再列它。
     */
    @Test
    @DisplayName("本机代码的令牌：登录态签一张；模型列表认、用量和存档不认；令牌签不了令牌；过期后不认、列表里不再有")
    void 本机代码的令牌() throws Exception {
        jdbc.update("INSERT INTO sys_user(username, password, nickname, role, status, deleted) VALUES ('desk-me', 'x', 'desk-me', 'USER', 1, 0)");
        Long me = jdbc.queryForObject("SELECT id FROM sys_user WHERE username = 'desk-me'", Long.class);
        String jwtToken = jwt.generateToken(me, "desk-me", 0, 3_600_000L);
        JsonNode minted = call("POST", "/api/access-tokens/desktop-code", jwtToken);
        assertTrue(minted != null, "网页的登录态签不出本机代码的令牌");
        String desk = minted.path("data").path("token").asText();
        assertTrue(desk.startsWith("zqp_"), minted.toString());
        assertTrue(!minted.path("data").path("expiresAt").isMissingNode() && !minted.path("data").path("expiresAt").isNull(), "要告诉页面什么时候过期：" + minted);
        assertEquals("DESKTOP_CODE", jdbc.queryForObject("SELECT scope FROM user_access_token WHERE user_id = ?", String.class, me));

        assertTrue(call("GET", "/api/harness/models", desk) != null, "本机代码要挑模型，令牌却不认");
        assertTrue(call("GET", "/api/harness/tools", desk) != null, "本机代码要远程工具，令牌却不认");
        assertEquals(null, call("GET", "/api/harness/usage", desk), "本机代码的令牌不该看得到用量");
        assertEquals(null, call("GET", "/api/harness/me", desk), "本机代码的令牌不该在 /me 被认");
        assertEquals(null, call("POST", "/api/access-tokens/desktop-code", desk), "令牌换不来令牌");
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM user_access_token WHERE user_id = ?", Integer.class, me), "拿令牌又签出了一张");
        JsonNode listed = call("GET", "/api/access-tokens", jwtToken);
        assertTrue(listed != null && listed.path("data").toString().contains("DESKTOP_CODE"), "设置里的列表没列它（撤销不了）：" + listed);

        jdbc.update("UPDATE user_access_token SET expires_at = ? WHERE user_id = ?", LocalDateTime.now().minusMinutes(1), me);
        assertEquals(null, call("GET", "/api/harness/models", desk), "过了期限还认");
        JsonNode after = call("GET", "/api/access-tokens", jwtToken);
        assertTrue(after != null && after.path("data").isArray() && after.path("data").size() == 0, "过期的还列着：" + after);
    }
}
