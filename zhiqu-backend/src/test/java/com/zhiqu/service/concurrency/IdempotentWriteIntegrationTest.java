package com.zhiqu.service.concurrency;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.security.JwtUtils;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfSystemProperty;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.context.annotation.ClassPathScanningCandidateComponentProvider;
import org.springframework.core.type.filter.AnnotationTypeFilter;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RestController;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.lang.reflect.Method;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 每一个登录后的写接口都认 {@code Idempotency-Key}（第二十二轮，{@link IdempotentWriteAspect}）—— 真 HTTP、真库。
 *
 * <p>真浏览器里把回应掐在回来的路上（服务器已经做完了），学生照着提示再点一次：例行计划、Notebook、Wiki 页、反馈、番茄钟记录
 * 全是两份，删除的第二下说「任务不存在或无权访问」。页面现在给每个写请求带键、回应丢了用同一个键重来 —— 这里看服务器那一半：
 * 同一个键再来只做一次、交回同一个结果；键不同 / 不带键照常各做各的；同一个键发给别的接口不串；同一个键同时来 20 下也只做一次。
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "app.cookie.secure=false",
        "app.rag.enabled=false",
        "app.proxy.trust-forwarded-headers=true"
})
class IdempotentWriteIntegrationTest {

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_idem_write")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @LocalServerPort private int port;
    @Autowired private JdbcTemplate jdbc;
    @Autowired private JwtUtils jwt;
    @Autowired private ObjectMapper json;
    @Autowired private org.springframework.data.redis.core.StringRedisTemplate redis;
    @Autowired private com.zhiqu.service.privacy.SensitiveCryptoService crypto;

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    private static final AtomicInteger PEER = new AtomicInteger(1);
    private Long userId;
    private String token;
    private long issuesBefore;

    @BeforeEach
    void seed() {
        String name = "idem_" + PEER.incrementAndGet();
        jdbc.update("INSERT INTO sys_user(username, password, nickname, role, status, deleted) VALUES (?, 'x', ?, 'USER', 1, 0)", name, name);
        userId = jdbc.queryForObject("SELECT id FROM sys_user WHERE username = ?", Long.class, name);
        token = jwt.generateToken(userId, name, 0, 3_600_000L);
        issuesBefore = jdbc.queryForObject("SELECT COALESCE(MAX(id), 0) FROM runtime_issue", Long.class);
    }

    record Reply(int status, JsonNode body) {
        int code() {
            return body == null ? -1 : body.path("code").asInt(-1);
        }
    }

    private Reply send(String method, String path, String body, String key) throws Exception {
        int n = PEER.incrementAndGet();
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .timeout(Duration.ofSeconds(30))
                .header("Content-Type", "application/json")
                .header("X-Forwarded-For", "10.8." + (n / 250 % 250) + "." + (n % 250 + 1))
                .header("Authorization", "Bearer " + token)
                .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
        if (key != null) {
            b.header("Idempotency-Key", key);
        }
        HttpResponse<String> r = http.send(b.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        JsonNode parsed = null;
        try {
            parsed = json.readTree(r.body());
        } catch (Exception ignored) {
            // 非 JSON 的回包：按状态码判
        }
        return new Reply(r.statusCode(), parsed);
    }

    private int count(String table) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM " + table + " WHERE user_id = ?", Integer.class, userId);
    }

    private void twiceSameKey(String what, String method, String path, String body, String table, int expectedRows) throws Exception {
        Reply first = send(method, path, body, "ui-" + what);
        Reply again = send(method, path, body, "ui-" + what);
        assertEquals(200, first.code(), what + " 第一次：" + first.body());
        assertEquals(200, again.code(), what + " 同一个键再来一次（回应丢了之后的重来）：" + again.body());
        assertEquals(first.body().path("data"), again.body().path("data"), what + "：再来一次交回的应当是上一次的结果");
        if (table != null) {
            assertEquals(expectedRows, count(table), what + "：同一个键来了两次，库里应当只有一份");
        }
    }

    @Test
    @DisplayName("回应丢了、用同一个键再来：新建例行计划 / 番茄钟记录 / Notebook / Wiki 页 / 反馈、打卡、删除 —— 都只做一次，交回同一个结果")
    void 同一个键只做一次() throws Exception {
        twiceSameKey("routine", "POST", "/api/routine", "{\"title\":\"背单词\",\"frequency\":\"DAILY\",\"durationMinutes\":10}", "study_routine", 1);
        twiceSameKey("record", "POST", "/api/record", "{\"durationMinutes\":25,\"note\":\"番茄钟\"}", "study_record", 1);
        twiceSameKey("notebook", "POST", "/api/ai/notebooks", "{\"title\":\"线代\"}", "ai_notebook", 1);
        twiceSameKey("page", "POST", "/api/knowledge/pages", "{\"title\":\"特征值\",\"content\":\"# x\",\"pageType\":\"topic\"}", "user_knowledge_page", 1);
        twiceSameKey("feedback", "POST", "/api/feedback", "{\"content\":\"按钮太小\",\"type\":\"bug\"}", "user_feedback", 1);
        long routine = jdbc.queryForObject("SELECT id FROM study_routine WHERE user_id = ?", Long.class, userId);
        twiceSameKey("checkin", "POST", "/api/routine/" + routine + "/checkin", "{\"status\":\"DONE\"}", null, 0);

        Reply task = send("POST", "/api/task", "{\"title\":\"要删的\",\"quadrant\":2}", null);
        long taskId = task.body().path("data").path("id").asLong();
        twiceSameKey("delete", "DELETE", "/api/task/" + taskId, null, null, 0);
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM study_task WHERE id = ? AND deleted = 0", Integer.class, taskId));
        assertNoIssues("同一个键只做一次");
    }

    @Test
    @DisplayName("不是重来的：换一个键、不带键 —— 照常各做各的（学生真的想建两个）；同一个键发给别的接口也照常做，不拿别处的结果")
    void 别的照常() throws Exception {
        assertEquals(200, send("POST", "/api/routine", "{\"title\":\"跑步\",\"frequency\":\"DAILY\"}", "ui-a").code());
        assertEquals(200, send("POST", "/api/routine", "{\"title\":\"跑步\",\"frequency\":\"DAILY\"}", "ui-b").code());
        assertEquals(2, count("study_routine"), "两个不同的键是两次");
        assertEquals(200, send("POST", "/api/routine", "{\"title\":\"跑步\",\"frequency\":\"DAILY\"}", null).code());
        assertEquals(200, send("POST", "/api/routine", "{\"title\":\"跑步\",\"frequency\":\"DAILY\"}", null).code());
        assertEquals(4, count("study_routine"), "不带键的照旧每次都做");

        Reply record = send("POST", "/api/record", "{\"durationMinutes\":25}", "ui-a");
        assertEquals(200, record.code(), "同一个键发给另一个接口：" + record.body());
        assertEquals(1, count("study_record"), "同一个键发给另一个接口应当照常执行，而不是交回例行计划那边的结果");
        assertNoIssues("别的照常");
    }

    @Test
    @DisplayName("同一个键同时来 20 下（重来和原来那一下撞在一起）：只做一次；其余交回同一个结果或说「上一次还在处理」（409），没有服务器出错")
    void 同时来() throws Exception {
        int n = 20;
        ExecutorService pool = Executors.newFixedThreadPool(n);
        CyclicBarrier gate = new CyclicBarrier(n);
        List<Reply> replies = new ArrayList<>();
        try {
            List<Future<Reply>> futures = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                futures.add(pool.submit(() -> {
                    gate.await(10, TimeUnit.SECONDS);
                    return send("POST", "/api/routine", "{\"title\":\"同时\",\"frequency\":\"DAILY\"}", "ui-storm");
                }));
            }
            for (Future<Reply> f : futures) {
                replies.add(f.get(60, TimeUnit.SECONDS));
            }
        } finally {
            pool.shutdownNow();
        }
        assertEquals(1, count("study_routine"), "同一个键同时来了 20 下，库里应当只有一份");
        for (Reply r : replies) {
            assertTrue(r.status() < 500 && (r.code() == 200 || r.code() == 409), "HTTP " + r.status() + " " + r.body());
        }
        Reply after = send("POST", "/api/routine", "{\"title\":\"同时\",\"frequency\":\"DAILY\"}", "ui-storm");
        long id = jdbc.queryForObject("SELECT id FROM study_routine WHERE user_id = ?", Long.class, userId);
        assertEquals(id, after.body().path("data").path("id").asLong(), "做完之后再来，交回的是那一份");
        assertNoIssues("同时来");
    }

    @Test
    @DisplayName("重启之后同一个键再来：还是只做一次 —— 没有 Redis（桌面应用）时结果原来只在进程里，kill -9 重启实测 1 条 → 2 条")
    void 重启之后也认得() {
        java.util.concurrent.atomic.AtomicInteger runs = new java.util.concurrent.atomic.AtomicInteger();
        java.util.function.Supplier<com.zhiqu.common.Result<Integer>> write = () -> com.zhiqu.common.Result.success(runs.incrementAndGet());
        // 两个实例 = 重启前后的两个进程：Redis 连不上（测试不连真 Redis），进程内的缓存各是各的，只有库是同一个
        IdempotencyService before = new IdempotencyService(redis, new RedisDistributedLockService(redis), json, jdbc, crypto);
        IdempotencyService after = new IdempotencyService(redis, new RedisDistributedLockService(redis), json, jdbc, crypto);
        assertEquals(1, before.execute(userId, "RoutineController.create POST /api/routine", "ui-restart", write).getData());
        assertEquals(1, after.execute(userId, "RoutineController.create POST /api/routine", "ui-restart", write).getData(),
                "重启之后同一个键再来，交回的应当是上一次的结果");
        assertEquals(1, runs.get(), "重启之后同一个键又做了一遍");
        jdbc.update("UPDATE idempotency_record SET expires_at = ? WHERE user_id = ?", java.time.LocalDateTime.now().minusSeconds(1), userId);
        IdempotencyService later = new IdempotencyService(redis, new RedisDistributedLockService(redis), json, jdbc, crypto);
        assertEquals(2, later.execute(userId, "RoutineController.create POST /api/routine", "ui-restart", write).getData(),
                "过了 10 分钟就不再认（和 Redis 里的一样）");
    }

    @Test
    @DisplayName("落库的回包是密文：新建的个人访问令牌、临时密码、任务标题这些，库里本来就不存明文")
    void 落库的是密文() throws Exception {
        String secret = "zqp_" + "s".repeat(40);
        IdempotencyService idem = new IdempotencyService(redis, new RedisDistributedLockService(redis), json, jdbc, crypto);
        idem.execute(userId, "AccessTokenController.create POST /api/access-tokens", "ui-secret",
                () -> com.zhiqu.common.Result.success(java.util.Map.of("token", secret)));
        List<String> stored = jdbc.queryForList("SELECT result_json FROM idempotency_record WHERE user_id = ?", String.class, userId);
        assertEquals(1, stored.size());
        assertTrue(!stored.get(0).contains(secret) && crypto.isEncrypted(stored.get(0)), "库里存的是明文：" + stored.get(0));
        IdempotencyService restarted = new IdempotencyService(redis, new RedisDistributedLockService(redis), json, jdbc, crypto);
        assertEquals(secret, ((java.util.Map<?, ?>) restarted.execute(userId, "AccessTokenController.create POST /api/access-tokens", "ui-secret",
                () -> com.zhiqu.common.Result.success(java.util.Map.of("token", "第二次不该执行"))).getData()).get("token"),
                "密文读回来要能解开，交回上一次的结果");
    }

    @Test
    @DisplayName("过期的清得完：每个写都插一行，一次只删 1000 行的话写得多了表只涨不落")
    void 过期的清得完() {
        java.time.LocalDateTime old = java.time.LocalDateTime.now().minusHours(1);
        jdbc.batchUpdate("INSERT INTO idempotency_record(key_hash, user_id, result_json, expires_at) VALUES (?, ?, 'x', ?)",
                java.util.stream.IntStream.range(0, 2500)
                        .mapToObj(i -> new Object[]{String.format("%064d", i), userId, old}).toList());
        IdempotencyService idem = new IdempotencyService(redis, new RedisDistributedLockService(redis), json, jdbc, crypto);
        java.time.LocalDateTime now = java.time.LocalDateTime.now();
        assertTrue(idem.sweepExpired(now) >= 2500, "一次清理没删完");
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM idempotency_record WHERE user_id = ? AND expires_at < ?",
                Integer.class, userId, now), "过期的还剩着");
    }

    @Test
    @DisplayName("哪些写接口不接这个头，一个一个列清楚：自己接了的、回应里带 Cookie 的、流式的 —— 新加的写接口默认都接")
    void 不接的只有这些() throws Exception {
        ClassPathScanningCandidateComponentProvider scan = new ClassPathScanningCandidateComponentProvider(false);
        scan.addIncludeFilter(new AnnotationTypeFilter(RestController.class));
        Set<String> skipped = new TreeSet<>();
        int writes = 0;
        for (var bean : scan.findCandidateComponents("com.zhiqu.controller")) {
            for (Method m : Class.forName(bean.getBeanClassName()).getDeclaredMethods()) {
                boolean write = m.isAnnotationPresent(PostMapping.class) || m.isAnnotationPresent(PutMapping.class)
                        || m.isAnnotationPresent(DeleteMapping.class) || m.isAnnotationPresent(PatchMapping.class);
                if (!write) {
                    continue;
                }
                writes++;
                if (!IdempotentWriteAspect.covers(m)) {
                    skipped.add(m.getDeclaringClass().getSimpleName() + "." + m.getName());
                }
            }
        }
        assertTrue(writes > 80, "扫到的写接口太少，扫描本身坏了：" + writes);
        assertEquals(new TreeSet<>(Set.of(
                // 自己在参数里接了这个头（各有自己的 scope）
                "StudyTaskController.create", "StudyTaskController.createWithRepeat",
                "AiController.batchCreateTasks", "AiController.batchCreatePlan", "SharedPlanController.apply",
                // 回应里带 Cookie：缓存的结果重放不出 Cookie
                "AuthController.login", "AuthController.logout", "UserController.updatePassword",
                // 流式回答（SseEmitter），没法缓存
                "AiController.streamChat", "HarnessController.modelStream")), skipped);
    }

    private void assertNoIssues(String what) {
        List<String> issues = jdbc.queryForList("SELECT CONCAT(category, '：', LEFT(message, 160)) FROM runtime_issue WHERE id > ? AND source = 'SERVER'",
                String.class, issuesBefore);
        assertTrue(issues.isEmpty(), what + "：出了运行问题：\n" + String.join("\n", issues));
    }
}
