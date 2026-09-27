package com.zhiqu.fuzz;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import com.zhiqu.security.JwtUtils;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
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

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 暴力测试之三：<b>AI 回答到一半就刷新 / 关页面、同一段对话一口气发好几条</b>（第十三轮）。
 *
 * <p>浏览器刷新时做的事，就是把正在读的那条 SSE 连接断掉。约定是「刷新不丢回答」：服务器照样把回答写完、写进库，
 * 页面重新打开时接回来。这里真开 HTTP、真读 SSE，读到第一个字就断开，一次断十个；之后要求每一条回答都写完（没有停在「正在生成」
 * 的消息、没有停在 RUNNING 的执行记录）、内容完整、没有运行问题。
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "spring.task.scheduling.enabled=false",
        "app.cookie.secure=false",
        "app.rag.enabled=false",
        "app.ai.allow-private-provider-url=true",
        "app.proxy.trust-forwarded-headers=true"
})
class StreamImpatienceIntegrationTest {

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_stream_storm")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    /** 假模型：流式回 20 段、每段隔 40 毫秒（给「读到第一个字就断开」留出时间）；非流式（记忆整理之类）回一个空数组。 */
    static final String FULL_REPLY = "第一段。".repeat(20);
    private static HttpServer model;

    @BeforeAll
    static void startModel() throws Exception {
        model = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        model.createContext("/v1/chat/completions", exchange -> {
            String req = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            boolean streaming = req.contains("\"stream\":true") || req.contains("\"stream\": true");
            if (!streaming) {
                byte[] body = "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"[]\"}}]}".getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, body.length);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(body);
                }
                return;
            }
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, 0);
            try (OutputStream out = exchange.getResponseBody()) {
                for (int i = 0; i < 20; i++) {
                    out.write(("data: {\"choices\":[{\"delta\":{\"content\":\"第一段。\"}}]}\n\n").getBytes(StandardCharsets.UTF_8));
                    out.flush();
                    Thread.sleep(40);
                }
                out.write("data: [DONE]\n\n".getBytes(StandardCharsets.UTF_8));
            } catch (Exception ignored) {
                // 客户端（我们的后端）断了：不是这里要测的
            }
        });
        model.setExecutor(Executors.newCachedThreadPool());
        model.start();
    }

    @AfterAll
    static void stopModel() {
        model.stop(0);
    }

    @LocalServerPort private int port;
    @Autowired private JdbcTemplate jdbc;
    @Autowired private JwtUtils jwt;
    @Autowired private ObjectMapper json;

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    private static final AtomicInteger PEER = new AtomicInteger(1);
    private Long userId;
    private String token;
    private long modelId;
    private long issuesBefore;

    private HttpRequest.Builder req(String path) {
        int n = PEER.incrementAndGet();
        return HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .timeout(Duration.ofSeconds(60))
                .header("Content-Type", "application/json")
                .header("X-Forwarded-For", "10.20." + (n / 250 % 250) + "." + (n % 250 + 1))
                .header("Authorization", "Bearer " + token);
    }

    private JsonNode call(HttpRequest r) throws Exception {
        return json.readTree(http.send(r, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8)).body());
    }

    @BeforeEach
    void seed() throws Exception {
        String name = "stream_" + PEER.incrementAndGet();
        jdbc.update("INSERT INTO sys_user(username, password, nickname, role, status, deleted) VALUES (?, 'x', ?, 'USER', 1, 0)", name, name);
        userId = jdbc.queryForObject("SELECT id FROM sys_user WHERE username = ?", Long.class, name);
        token = jwt.generateToken(userId, name, 0, 3_600_000L);
        JsonNode m = call(req("/api/ai/models").POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(Map.of(
                "providerType", "OPENAI_COMPATIBLE", "displayName", "fake", "modelName", "fake-model", "apiKey", "sk-test",
                "apiUrl", "http://127.0.0.1:" + model.getAddress().getPort() + "/v1/chat/completions")))).build());
        modelId = m.path("data").path("id").asLong();
        issuesBefore = jdbc.queryForObject("SELECT COALESCE(MAX(id), 0) FROM runtime_issue", Long.class);
    }

    private long notebook() throws Exception {
        return call(req("/api/ai/notebooks").POST(HttpRequest.BodyPublishers.ofString("{\"title\":\"风暴\"}")).build())
                .path("data").path("id").asLong();
    }

    private HttpRequest chat(long notebookId, String message) throws Exception {
        return req("/api/ai/chat/stream").header("Accept", "text/event-stream").POST(HttpRequest.BodyPublishers.ofString(
                json.writeValueAsString(Map.of("message", message, "modelConfigId", modelId, "notebookId", notebookId, "agentMode", "CHAT_ONLY")))).build();
    }

    /** 读 SSE 直到看见第一段回答，然后关掉连接 —— 就是刷新页面时浏览器做的事。 */
    private void readFirstDeltaThenLeave(HttpRequest r) throws Exception {
        HttpResponse<InputStream> res = http.send(r, HttpResponse.BodyHandlers.ofInputStream());
        try (InputStream in = res.body(); BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.startsWith("event:message.delta")) {
                    return;
                }
            }
        }
    }

    /** 等到这个人没有「正在生成」的消息、也没有 RUNNING 的执行记录。 */
    private void awaitSettled() throws Exception {
        long deadline = System.currentTimeMillis() + 30_000;
        while (System.currentTimeMillis() < deadline) {
            Integer streaming = jdbc.queryForObject("SELECT COUNT(*) FROM ai_message WHERE user_id = ? AND status = 'STREAMING' AND deleted = 0", Integer.class, userId);
            Integer running = jdbc.queryForObject("SELECT COUNT(*) FROM ai_agent_run WHERE user_id = ? AND status = 'RUNNING'", Integer.class, userId);
            if (streaming == 0 && running == 0) {
                return;
            }
            Thread.sleep(200);
        }
        throw new AssertionError("30 秒后还有消息停在「正在生成」或者执行记录停在 RUNNING");
    }

    private void noServerIssues() {
        List<String> issues = jdbc.queryForList("SELECT CONCAT(category, '：', LEFT(message, 160)) FROM runtime_issue WHERE id > ? AND source = 'SERVER'",
                String.class, issuesBefore);
        assertTrue(issues.isEmpty(), "出现了运行问题：\n" + String.join("\n", issues));
    }

    @Test
    @DisplayName("十个回答同时进行、每个读到第一个字就断开（刷新）：回答照样全部写完、内容完整，没有停在「正在生成」的")
    void 读到一半就刷新() throws Exception {
        int n = 10;
        List<Long> notebooks = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            notebooks.add(notebook());
        }
        ExecutorService pool = Executors.newFixedThreadPool(n);
        CyclicBarrier gate = new CyclicBarrier(n);
        try {
            List<Future<?>> all = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                final long nb = notebooks.get(i);
                all.add(pool.submit(() -> {
                    gate.await(10, TimeUnit.SECONDS);
                    readFirstDeltaThenLeave(chat(nb, "讲讲特征值"));
                    return null;
                }));
            }
            for (Future<?> f : all) {
                f.get(60, TimeUnit.SECONDS);
            }
        } finally {
            pool.shutdownNow();
        }
        awaitSettled();
        List<Map<String, Object>> answers = jdbc.queryForList(
                "SELECT status, content FROM ai_message WHERE user_id = ? AND role = 'assistant' AND deleted = 0", userId);
        assertEquals(n, answers.size(), "回答的条数不对");
        for (Map<String, Object> a : answers) {
            assertEquals("DONE", a.get("status"));
            assertEquals(FULL_REPLY, a.get("content"), "断开之后回答没写完整");
        }
        noServerIssues();
    }

    @Test
    @DisplayName("刚发出去就刷新：重新打开时这一问一答都在（回答要么还在生成、要么已经完整），最后是完整的")
    void 刚发就刷新() throws Exception {
        long nb = notebook();
        readFirstDeltaThenLeave(chat(nb, "马上刷新"));
        JsonNode list = call(req("/api/ai/messages?notebookId=" + nb).GET().build());
        List<String> roles = new ArrayList<>();
        list.path("data").forEach(m -> roles.add(m.path("role").asText()));
        assertTrue(roles.contains("user") && roles.contains("assistant"), "刷新之后这一问一答不全：" + list);
        awaitSettled();
        assertEquals(FULL_REPLY, jdbc.queryForObject(
                "SELECT content FROM ai_message WHERE user_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1", String.class, userId));
        noServerIssues();
    }

    @Test
    @DisplayName("同一段对话一口气发 5 条（不等回答）：每条都有回答、一问一答成对、不死锁")
    void 同一段对话连发() throws Exception {
        long nb = notebook();
        int n = 5;
        ExecutorService pool = Executors.newFixedThreadPool(n);
        CyclicBarrier gate = new CyclicBarrier(n);
        try {
            List<Future<?>> all = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                final int k = i;
                all.add(pool.submit(() -> {
                    gate.await(10, TimeUnit.SECONDS);
                    http.send(chat(nb, "第 " + k + " 个问题"), HttpResponse.BodyHandlers.ofString());
                    return null;
                }));
            }
            for (Future<?> f : all) {
                f.get(60, TimeUnit.SECONDS);
            }
        } finally {
            pool.shutdownNow();
        }
        awaitSettled();
        assertEquals(n, jdbc.queryForObject("SELECT COUNT(*) FROM ai_message WHERE user_id = ? AND role = 'user' AND deleted = 0", Integer.class, userId));
        assertEquals(n, jdbc.queryForObject("SELECT COUNT(*) FROM ai_message WHERE user_id = ? AND role = 'assistant' AND status = 'DONE' AND deleted = 0", Integer.class, userId));
        noServerIssues();
    }
}
