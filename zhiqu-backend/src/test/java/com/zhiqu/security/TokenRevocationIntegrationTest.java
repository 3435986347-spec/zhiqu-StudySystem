package com.zhiqu.security;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.entity.SysUser;
import com.zhiqu.mapper.SysUserMapper;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import jakarta.servlet.http.Cookie;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfSystemProperty;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.nio.charset.StandardCharsets;
import java.util.Date;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

/**
 * 改密码之后，之前签发的登录令牌一并失效 —— 走真的 HTTP 过滤器链、真的 MySQL。
 *
 * <p>原来 JWT 无状态，改了密码旧令牌照样能用到过期（记住我 30 天）。而改密码正是账号被盗后用户能做的那件事。
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
class TokenRevocationIntegrationTest {

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_token_test")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @Autowired private MockMvc mvc;
    @Autowired private JdbcTemplate jdbc;
    @Autowired private SysUserMapper users;
    @Autowired private ObjectMapper json;
    @Value("${jwt.secret}") private String secret;

    /** 登录 / 注册限流是每个 IP 12 次 / 分钟：每次换一个来源地址，就像不同的人在登 */
    private static final java.util.concurrent.atomic.AtomicInteger PEER = new java.util.concurrent.atomic.AtomicInteger(1);

    private static MockHttpServletRequestBuilder fromNewPeer(MockHttpServletRequestBuilder request) {
        int n = PEER.incrementAndGet();
        return request.with(r -> { r.setRemoteAddr("203.0." + (n / 250) + "." + (n % 250 + 1)); return r; });
    }

    private JsonNode call(MockHttpServletRequestBuilder request) throws Exception {
        MockHttpServletResponse r = mvc.perform(request).andReturn().getResponse();
        return r.getStatus() == 200 ? json.readTree(r.getContentAsString(StandardCharsets.UTF_8)) : null;
    }

    private String register(String name, String password) throws Exception {
        JsonNode r = call(fromNewPeer(post("/api/auth/register")).contentType(MediaType.APPLICATION_JSON)
                .content("{\"username\":\"" + name + "\",\"password\":\"" + password + "\",\"confirmPassword\":\"" + password + "\"}"));
        assertEquals(200, r.path("code").asInt(), r.toString());
        return r.path("data").path("token").asText();
    }

    private String login(String name, String password, boolean remember) throws Exception {
        JsonNode r = call(fromNewPeer(post("/api/auth/login")).contentType(MediaType.APPLICATION_JSON)
                .content("{\"username\":\"" + name + "\",\"password\":\"" + password + "\",\"rememberMe\":" + remember + "}"));
        return r != null && r.path("code").asInt() == 200 ? r.path("data").path("token").asText() : null;
    }

    /** 这张令牌现在还能不能用：能用 = /api/auth/info 回 200 且业务码 200。 */
    private boolean works(String token) throws Exception {
        JsonNode r = call(get("/api/auth/info").header("Authorization", "Bearer " + token));
        return r != null && r.path("code").asInt() == 200;
    }

    private JsonNode changePassword(String token, String oldPassword, String newPassword) throws Exception {
        return call(put("/api/user/password").header("Authorization", "Bearer " + token).contentType(MediaType.APPLICATION_JSON)
                .content("{\"oldPassword\":\"" + oldPassword + "\",\"newPassword\":\"" + newPassword + "\"}"));
    }

    @Test
    @DisplayName("改密码：这个会话拿到新令牌接着用；之前的令牌（这张、别的设备上记住我的那张）全部失效；新密码能登、旧密码不能")
    void 改密码吊销旧令牌() throws Exception {
        register("revoke-me", "old-pass-123");
        String laptop = login("revoke-me", "old-pass-123", false);
        String phone = login("revoke-me", "old-pass-123", true);
        assertTrue(works(laptop) && works(phone), "改密码之前两张都该能用");

        JsonNode r = changePassword(laptop, "old-pass-123", "new-pass-456");
        assertEquals(200, r.path("code").asInt(), r.toString());
        String fresh = r.path("data").path("token").asText();

        assertTrue(works(fresh), "这个会话的新令牌要能用");
        assertTrue(!works(laptop), "改密码时用的那张旧令牌还能用");
        assertTrue(!works(phone), "别的设备上记住我的那张还能用 —— 被偷走的令牌在改密码之后仍然有效");
        assertTrue(login("revoke-me", "old-pass-123", false) == null, "旧密码还能登录");
        String relogin = login("revoke-me", "new-pass-456", false);
        assertTrue(relogin != null && works(relogin), "用新密码重新登录拿到的令牌要能用（签发时要带上新的纪元）");
    }

    @Test
    @DisplayName("新令牌的到期时间和原来那张一样（记住我照旧）；请求带着记住我的 Cookie 的话，Cookie 也换成新令牌")
    void 到期时间与Cookie() throws Exception {
        register("keep-expiry", "old-pass-123");
        String remembered = login("keep-expiry", "old-pass-123", true);
        long before = Jwts.parser().verifyWith(Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8))).build()
                .parseSignedClaims(remembered).getPayload().getExpiration().getTime();

        MockHttpServletResponse response = mvc.perform(put("/api/user/password")
                        .cookie(new Cookie(JwtAuthenticationFilter.AUTH_COOKIE_NAME, remembered))
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"oldPassword\":\"old-pass-123\",\"newPassword\":\"new-pass-456\"}"))
                .andReturn().getResponse();
        JsonNode r = json.readTree(response.getContentAsString(StandardCharsets.UTF_8));
        assertEquals(200, r.path("code").asInt(), r.toString());
        long after = r.path("data").path("expiresAt").asLong();
        assertTrue(Math.abs(after - before) < 1000, "到期时间变了：" + before + " → " + after);

        String setCookie = String.join("\n", response.getHeaders("Set-Cookie"));
        String fresh = r.path("data").path("token").asText();
        assertTrue(setCookie.contains(JwtAuthenticationFilter.AUTH_COOKIE_NAME + "=" + fresh), "Cookie 没换成新令牌：" + setCookie);
        assertTrue(!works(remembered));
    }

    @Test
    @DisplayName("管理员重置密码：那个人之前的令牌全部失效")
    void 管理员重置吊销() throws Exception {
        register("reset-me", "old-pass-123");
        String victim = login("reset-me", "old-pass-123", true);
        register("the-admin", "admin-pass-123");
        jdbc.update("UPDATE sys_user SET role='ADMIN' WHERE username='the-admin'");
        String admin = login("the-admin", "admin-pass-123", false);
        long id = jdbc.queryForObject("SELECT id FROM sys_user WHERE username='reset-me'", Long.class);

        JsonNode r = call(post("/api/admin/users/" + id + "/reset-password").header("Authorization", "Bearer " + admin));
        assertEquals(200, r.path("code").asInt(), r.toString());
        assertTrue(!works(victim), "重置之后旧令牌还能用");
        assertTrue(works(admin), "管理员自己的令牌不受影响");
    }

    @Test
    @DisplayName("上线前签发的旧令牌（没有纪元声明）：没改过密码照常能用，改过一次就失效")
    void 旧令牌兼容() throws Exception {
        register("legacy", "old-pass-123");
        long id = jdbc.queryForObject("SELECT id FROM sys_user WHERE username='legacy'", Long.class);
        String legacy = Jwts.builder().subject(String.valueOf(id)).claim("username", "legacy").issuedAt(new Date())
                .expiration(new Date(System.currentTimeMillis() + 3_600_000))
                .signWith(Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8))).compact();
        assertTrue(works(legacy), "上线时谁都不该被踢下线");
        String current = login("legacy", "old-pass-123", false);
        changePassword(current, "old-pass-123", "new-pass-456");
        assertTrue(!works(legacy));
    }

    @Test
    @DisplayName("改密码是一条只动密码几列的语句，并把 version 加一：之后拿旧版本号的整行写入失败，不会把旧密码写回去")
    void 整行写回不会改回旧密码() throws Exception {
        register("stale-write", "old-pass-123");
        SysUser stale = users.selectOne(new com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper<SysUser>()
                .eq(SysUser::getUsername, "stale-write"));
        String current = login("stale-write", "old-pass-123", false);
        assertEquals(200, changePassword(current, "old-pass-123", "new-pass-456").path("code").asInt());

        stale.setNickname("并发改资料");
        assertEquals(0, users.updateById(stale), "拿着旧版本号的整行写入居然成功了");
        String hash = jdbc.queryForObject("SELECT password FROM sys_user WHERE id=?", String.class, stale.getId());
        assertNotEquals(stale.getPassword(), hash, "旧密码被写回去了");
        assertTrue(login("stale-write", "new-pass-456", false) != null);
    }
}
