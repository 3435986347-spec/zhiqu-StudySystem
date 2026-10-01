package com.zhiqu.fuzz;

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
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.IntFunction;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 暴力测试之二：<b>没耐心的人</b>（第十三轮，用户要的「测试没有耐心的极端情况」）。
 *
 * <p>连点、开两个标签页一起点、等不及又点 —— 同一个写库的动作<b>真正同时</b>打 20 次（真 HTTP、真库、屏障同时放行），
 * 每个动作之后看三件事：没有运行问题（未处理异常）、没有 5xx、库里的结果对（只生效一次 / 计数和明细对得上）。
 * 撞了唯一键、乐观锁这类并发冲突，该变成一句友好的话，不是「服务器出错」。
 *
 * <p>限流按来源 IP：这里打开「信任回环来的 X-Forwarded-For」、每个请求报一个不同的地址 —— 测的是并发，不是限流。
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "app.cookie.secure=false",
        "app.rag.enabled=false",
        "app.proxy.trust-forwarded-headers=true"
})
class ConcurrencyStormIntegrationTest {

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_storm")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    static final int N = 20;

    @LocalServerPort private int port;
    @org.springframework.beans.factory.annotation.Value("${spring.data.redis.port}") private int redisPort;
    @Autowired private JdbcTemplate jdbc;
    @Autowired private org.springframework.context.ApplicationContext context;
    @Autowired private JwtUtils jwt;
    @Autowired private ObjectMapper json;

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    private static final AtomicInteger PEER = new AtomicInteger(1);
    private Long userId;
    private String token;
    private long issuesBefore;

    @BeforeEach
    void seed() {
        // 测试不许连开发机上的真 Redis（src/test/resources/application.properties）：连了的话幂等结果跨测试串，
        // 「同一个键套用 20 次」会拿到上一次跑剩下的「成功」、一条任务都不建 —— 这一轮就是这么时好时坏的
        org.junit.jupiter.api.Assertions.assertNotEquals(6379, redisPort, "集成测试连到了开发机的 Redis");
        // 定时任务在测试上下文里不许跑（SchedulingConfig + 测试的 application.properties）：跑的话 RAG worker 每秒领作业、
        // 测试结束卡在停掉的 MySQL 上 30 秒（第十四轮）
        org.junit.jupiter.api.Assertions.assertFalse(context.containsBean(
                org.springframework.scheduling.config.TaskManagementConfigUtils.SCHEDULED_ANNOTATION_PROCESSOR_BEAN_NAME),
                "集成测试的上下文里定时任务开着");
        String name = "storm_" + PEER.incrementAndGet();
        jdbc.update("INSERT INTO sys_user(username, password, nickname, role, status, deleted) VALUES (?, 'x', ?, 'USER', 1, 0)", name, name);
        userId = jdbc.queryForObject("SELECT id FROM sys_user WHERE username = ?", Long.class, name);
        token = jwt.generateToken(userId, name, 0, 3_600_000L);
        issuesBefore = jdbc.queryForObject("SELECT COALESCE(MAX(id), 0) FROM runtime_issue", Long.class);
    }

    record Reply(int status, JsonNode body) {
        int code() {
            return body == null ? -1 : body.path("code").asInt(-1);
        }

        String message() {
            return body == null ? "" : body.path("message").asText("");
        }
    }

    private HttpRequest.Builder req(String path) {
        int n = PEER.incrementAndGet();
        return HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .timeout(Duration.ofSeconds(30))
                .header("Content-Type", "application/json")
                .header("X-Forwarded-For", "10.9." + (n / 250 % 250) + "." + (n % 250 + 1))
                .header("Authorization", "Bearer " + token);
    }

    private Reply send(HttpRequest request) throws Exception {
        HttpResponse<String> r = http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        JsonNode body = null;
        try {
            body = json.readTree(r.body());
        } catch (Exception ignored) {
            // 非 JSON 的回包：body 留空，下面按状态码判
        }
        return new Reply(r.statusCode(), body);
    }

    /** 同一个请求真正同时打 n 次：n 个线程在屏障上等齐了一起放。 */
    private List<Reply> storm(IntFunction<HttpRequest> build) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(N);
        CyclicBarrier gate = new CyclicBarrier(N);
        try {
            List<Future<Reply>> futures = new ArrayList<>();
            for (int i = 0; i < N; i++) {
                final int k = i;
                futures.add(pool.submit(() -> {
                    HttpRequest r = build.apply(k);
                    gate.await(10, TimeUnit.SECONDS);
                    return send(r);
                }));
            }
            List<Reply> replies = new ArrayList<>();
            for (Future<Reply> f : futures) {
                replies.add(f.get(60, TimeUnit.SECONDS));
            }
            return replies;
        } finally {
            pool.shutdownNow();
        }
    }

    /** 每一场风暴之后：没有 5xx、没有运行问题（未处理异常）。 */
    private void calm(String what, List<Reply> replies) {
        for (Reply r : replies) {
            assertTrue(r.status() < 500, what + "：HTTP " + r.status() + " " + r.body());
        }
        List<String> issues = jdbc.queryForList("SELECT CONCAT(category, '：', LEFT(message, 160)) FROM runtime_issue WHERE id > ? AND source = 'SERVER'",
                String.class, issuesBefore);
        assertTrue(issues.isEmpty(), what + "：并发冲突变成了服务器出错（运行问题）：\n" + String.join("\n", issues));
    }

    private static HttpRequest.BodyPublisher body(String s) {
        return HttpRequest.BodyPublishers.ofString(s, StandardCharsets.UTF_8);
    }

    @Test
    @DisplayName("同一个用户名同时注册 20 次：只建一个账号，其余说「用户名已存在」—— 不是服务器出错")
    void 同名注册() throws Exception {
        List<Reply> replies = storm(k -> req("/api/auth/register").POST(body(
                "{\"username\":\"same-name\",\"password\":\"pass-1234\",\"confirmPassword\":\"pass-1234\"}")).build());
        calm("同名注册", replies);
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM sys_user WHERE username = 'same-name'", Integer.class));
        assertEquals(1, replies.stream().filter(r -> r.code() == 200).count(), "成功的不是正好一个");
        for (Reply r : replies) {
            assertTrue(r.code() == 200 || r.message().contains("已存在") || r.status() == 429, "失败的那些没说清原因：" + r.body());
        }
    }

    @Test
    @DisplayName("同时新建 20 个例行计划、20 个任务（双击、两个标签页）：各建出 20 个、成就积分只加一次，没有服务器出错")
    void 同时新建() throws Exception {
        // 第十四轮真浏览器里双击「创建例行计划」撞出来的：两个请求同时解锁同一个成就 → 死锁 → MySQL 回滚整个事务，
        // 而重试注解在里层（成就检查）上又跑了一遍 —— 外层事务早被标成 rollback-only，提交时 UnexpectedRollbackException
        List<Reply> routines = storm(k -> req("/api/routine").POST(body("{\"title\":\"风暴例行" + k + "\",\"frequency\":\"DAILY\"}")).build());
        calm("同时新建例行计划", routines);
        assertEquals(N, jdbc.queryForObject("SELECT COUNT(*) FROM study_routine WHERE user_id = ? AND deleted = 0", Integer.class, userId));
        List<Reply> tasks = storm(k -> req("/api/task").POST(body("{\"title\":\"风暴任务" + k + "\",\"quadrant\":2}")).build());
        calm("同时新建任务", tasks);
        assertEquals(N, jdbc.queryForObject("SELECT COUNT(*) FROM study_task WHERE user_id = ? AND deleted = 0", Integer.class, userId));
        Integer unlockedPoints = jdbc.queryForObject("SELECT COALESCE(SUM(d.points), 0) FROM user_achievement ua JOIN achievement_def d ON d.id = ua.achievement_id WHERE ua.user_id = ?",
                Integer.class, userId);
        assertTrue(unlockedPoints > 0, "这一场应当解锁了成就（否则没考到并发解锁）");
        assertEquals(unlockedPoints, jdbc.queryForObject("SELECT COALESCE(achievement_points, 0) FROM sys_user WHERE id = ?", Integer.class, userId),
                "成就积分应当正好是解锁的那几个成就的分数之和（加重了 = 重试时重复加分）");
    }

    @Test
    @DisplayName("带 Idempotency-Key 的接口上填错日期：回 400、说清应当像什么，不回 Java 原文（第十四轮：幂等那一层原来把异常包成带原文的业务错误）")
    void 幂等接口上的坏日期() throws Exception {
        long plan = approvedPlan();
        Reply r = send(req("/api/shared-plans/" + plan + "/apply").header("Idempotency-Key", "bad-date-" + plan)
                .POST(body("{\"startDate\":\"2026-02-30\"}")).build());
        assertEquals(400, r.code(), r.body() == null ? "" : r.body().toString());
        assertTrue(r.message().contains("应当像 2026-09-28") && !r.message().contains("could not be parsed"), r.message());
        calm("幂等接口上的坏日期", List.of(r));
    }

    @Test
    @DisplayName("同一个例行计划同一天打卡 20 次：只有一条打卡记录，都回成功")
    void 连点打卡() throws Exception {
        Reply created = send(req("/api/routine").POST(body("{\"title\":\"每天背单词\",\"frequency\":\"DAILY\"}")).build());
        long routine = created.body().path("data").path("id").asLong();
        List<Reply> replies = storm(k -> req("/api/routine/" + routine + "/checkin").POST(body("{}")).build());
        calm("连点打卡", replies);
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM study_routine_checkin WHERE routine_id = ?", Integer.class, routine));
        assertTrue(replies.stream().allMatch(r -> r.code() == 200), "有的打卡失败了：" + replies.stream().map(Reply::body).toList());
    }

    @Test
    @DisplayName("同一个任务同时标完成 20 次、同时删 20 次：状态对、只删一次，其余说清楚")
    void 连点完成与删除() throws Exception {
        Reply created = send(req("/api/task").POST(body("{\"title\":\"复习线代\",\"quadrant\":2}")).build());
        long task = created.body().path("data").path("id").asLong();
        calm("完成任务", storm(k -> req("/api/task/" + task + "/status?status=1").PUT(body("")).build()));
        assertEquals(1, jdbc.queryForObject("SELECT status FROM study_task WHERE id = ?", Integer.class, task));
        List<Reply> deletes = storm(k -> req("/api/task/" + task).DELETE().build());
        calm("删除任务", deletes);
        assertEquals(1, jdbc.queryForObject("SELECT deleted FROM study_task WHERE id = ?", Integer.class, task));
    }

    private long approvedPlan() {
        jdbc.update("INSERT INTO shared_plan_template(user_id, title, status, deleted) VALUES (?, '四周线代', 'APPROVED', 0)", userId);
        long id = jdbc.queryForObject("SELECT MAX(id) FROM shared_plan_template", Long.class);
        jdbc.update("INSERT INTO shared_plan_task_template(template_id, title, relative_start_day) VALUES (?, '风暴·第一周', 0)", id);
        jdbc.update("INSERT INTO shared_plan_task_template(template_id, title, relative_start_day) VALUES (?, '风暴·第二周', 7)", id);
        return id;
    }

    @Test
    @DisplayName("同一个参考计划同时点赞 20 次：点赞数和点赞记录对得上")
    void 连点点赞() throws Exception {
        long plan = approvedPlan();
        calm("点赞", storm(k -> req("/api/shared-plans/" + plan + "/like").POST(body("")).build()));
        Integer rows = jdbc.queryForObject("SELECT COUNT(*) FROM shared_plan_like WHERE template_id = ?", Integer.class, plan);
        Integer count = jdbc.queryForObject("SELECT like_count FROM shared_plan_template WHERE id = ?", Integer.class, plan);
        assertEquals(rows, count, "点赞数 " + count + " 和点赞记录 " + rows + " 对不上");
    }

    @Test
    @DisplayName("同一个幂等键同时套用 20 次：计划里的任务只建一份")
    void 连点套用() throws Exception {
        long plan = approvedPlan();
        List<Reply> replies = storm(k -> req("/api/shared-plans/" + plan + "/apply").header("Idempotency-Key", "ui-storm:2026-10-01")
                .POST(body("{\"startDate\":\"2026-10-01\"}")).build());
        calm("套用", replies);
        java.util.Map<String, Long> said = new java.util.TreeMap<>();
        replies.forEach(r -> said.merge(r.code() + " " + r.message(), 1L, Long::sum));
        assertEquals(2, jdbc.queryForObject("SELECT COUNT(*) FROM study_task WHERE user_id = ? AND deleted = 0", Integer.class, userId),
                "同一次套用应当正好建一份（2 条任务）；20 次回的是：" + said);
    }

    @Test
    @DisplayName("同一个 AI 计划草稿同时确认 20 次：任务只建一份，草稿是已确认")
    void 连点确认草稿() throws Exception {
        jdbc.update("INSERT INTO ai_agent_run(user_id, status, agent_mode) VALUES (?, 'DONE', 'AUTO')", userId);
        long run = jdbc.queryForObject("SELECT MAX(id) FROM ai_agent_run", Long.class);
        jdbc.update("INSERT INTO ai_agent_artifact(run_id, artifact_type, title, content_json, status) VALUES (?, 'PLAN_DRAFT', '两周计划', ?, 'DRAFT')",
                run, "{\"tasks\":[{\"title\":\"草稿任务甲\",\"quadrant\":2},{\"title\":\"草稿任务乙\",\"quadrant\":1}]}");
        long artifact = jdbc.queryForObject("SELECT MAX(id) FROM ai_agent_artifact", Long.class);
        calm("确认草稿", storm(k -> req("/api/ai/artifacts/" + artifact + "/confirm").POST(body("")).build()));
        assertEquals(2, jdbc.queryForObject("SELECT COUNT(*) FROM study_task WHERE user_id = ? AND deleted = 0", Integer.class, userId),
                "同一个草稿被确认了不止一次");
        assertEquals("CONFIRMED", jdbc.queryForObject("SELECT status FROM ai_agent_artifact WHERE id = ?", String.class, artifact));
    }

    @Test
    @DisplayName("同一个 Wiki 页拿同一个版本同时保存 20 次：只有一次成功、版本只涨一，其余说「被别的窗口改过」")
    void 两个窗口一起保存() throws Exception {
        Reply created = send(req("/api/knowledge/pages").POST(body("{\"title\":\"线性代数笔记\",\"content\":\"第一版\"}")).build());
        long page = created.body().path("data").path("id").asLong();
        int version = created.body().path("data").path("version").asInt();
        List<Reply> replies = storm(k -> req("/api/knowledge/pages/" + page).PUT(body(
                "{\"title\":\"线性代数笔记\",\"content\":\"第 " + k + " 个窗口写的\",\"version\":" + version + "}")).build());
        calm("并发保存", replies);
        assertEquals(1, replies.stream().filter(r -> r.code() == 200).count(), "同一个版本保存成功了不止一次（后写的冲掉了先写的）");
        assertEquals(version + 1, jdbc.queryForObject("SELECT version FROM user_knowledge_page WHERE id = ?", Integer.class, page));
    }
}
