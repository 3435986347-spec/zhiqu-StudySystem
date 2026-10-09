package com.zhiqu.fuzz;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
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
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 暴力测试：<b>模型那一侧不配合</b>（第十九轮）。一个按脚本演各种坏法的假供应商，走真的 HTTP、真的 SSE、真的库。
 *
 * <p>每一种坏法都看三件事：用户在流里收到的那句话（能看懂、不带接口地址 / key / HTML / 异常原文）、
 * 库里那条回答的状态与正文（没有停在「正在生成」、已经出来的半截还在）、不记运行问题（供应商的毛病不是我们的 bug）。
 * 「接上了不说话」「说几个字就不动了」要等 60 秒，不在这里跑 —— 那两种的说法由 {@code ProviderFailureTest} 判。
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "app.cookie.secure=false",
        "app.rag.enabled=false",
        "app.ai.allow-private-provider-url=true",
        "app.proxy.trust-forwarded-headers=true"
})
class ModelMisbehaviorIntegrationTest {

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_model_misbehavior").withUsername("zhiqu").withPassword("zhiqu");

    interface Script {
        void run(HttpExchange ex) throws Exception;
    }

    static volatile Script current;
    static HttpServer model;
    static final String KEY = "sk-probe-SECRET-0123456789abcdef";
    static final ObjectMapper MAPPER = new ObjectMapper();

    static void sse(HttpExchange ex) throws Exception {
        ex.getResponseHeaders().set("Content-Type", "text/event-stream");
        ex.sendResponseHeaders(200, 0);
    }

    static void chunk(OutputStream out, String text) throws Exception {
        out.write(("data: {\"choices\":[{\"delta\":{\"content\":" + MAPPER.writeValueAsString(text) + "}}]}\n\n").getBytes(StandardCharsets.UTF_8));
        out.flush();
    }

    static void body(HttpExchange ex, int status, String type, String text) throws Exception {
        byte[] b = text.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", type);
        ex.sendResponseHeaders(status, b.length);
        try (OutputStream out = ex.getResponseBody()) {
            out.write(b);
        }
    }

    @BeforeAll
    static void start() throws Exception {
        model = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        model.createContext("/v1/chat/completions", ex -> {
            String req = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            try {
                if (!req.contains("\"stream\":true")) {
                    // 回答之后的记忆整理之类：好好回，只让「回答」这一次出毛病
                    body(ex, 200, "application/json", "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"[]\"}}]}");
                    return;
                }
                current.run(ex);
            } catch (Exception ignored) {
                // 我们的后端提前断开（回答太长时就是这样）：不是这里要测的
            } finally {
                ex.close();
            }
        });
        model.setExecutor(Executors.newCachedThreadPool());
        model.start();
    }

    @AfterAll
    static void stop() {
        model.stop(0);
    }

    @LocalServerPort
    int port;
    @Autowired
    JdbcTemplate jdbc;
    @Autowired
    JwtUtils jwt;
    @Autowired
    ObjectMapper json;
    final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    static final AtomicInteger PEER = new AtomicInteger(1);
    String token;
    Long userId;
    long modelId;
    long issuesBefore;

    HttpRequest.Builder req(String path) {
        int n = PEER.incrementAndGet();
        return HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path)).timeout(Duration.ofSeconds(60))
                .header("Content-Type", "application/json")
                .header("X-Forwarded-For", "10.31." + (n / 250 % 250) + "." + (n % 250 + 1))
                .header("Authorization", "Bearer " + token);
    }

    JsonNode call(HttpRequest r) throws Exception {
        return json.readTree(http.send(r, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8)).body());
    }

    long modelConfig(String url) throws Exception {
        return call(req("/api/ai/models").POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(Map.of(
                "providerType", "OPENAI_COMPATIBLE", "displayName", "坏模型", "modelName", "probe-model", "apiKey", KEY,
                "apiUrl", url)))).build()).path("data").path("id").asLong();
    }

    @BeforeEach
    void seed() throws Exception {
        String name = "misbehave_" + PEER.incrementAndGet();
        jdbc.update("INSERT INTO sys_user(username, password, nickname, role, status, deleted) VALUES (?, 'x', ?, 'USER', 1, 0)", name, name);
        userId = jdbc.queryForObject("SELECT id FROM sys_user WHERE username = ?", Long.class, name);
        token = jwt.generateToken(userId, name, 0, 3_600_000L);
        modelId = modelConfig("http://127.0.0.1:" + model.getAddress().getPort() + "/v1/chat/completions");
        issuesBefore = jdbc.queryForObject("SELECT COALESCE(MAX(id), 0) FROM runtime_issue", Long.class);
    }

    /** 一轮问答的结果：流里的错误、流里收到了多少字、库里那条回答、列表接口回的那条。 */
    record Outcome(String sseError, int deltaChars, Map<String, Object> row, JsonNode listed, String runStatus) {
        String status() {
            return String.valueOf(row.get("status"));
        }

        String content() {
            return String.valueOf(row.get("content"));
        }

        String error() {
            return row.get("error_message") == null ? null : String.valueOf(row.get("error_message"));
        }
    }

    Outcome ask(Script script, long withModel) throws Exception {
        current = script;
        long nb = call(req("/api/ai/notebooks").POST(HttpRequest.BodyPublishers.ofString("{\"title\":\"坏模型\"}")).build()).path("data").path("id").asLong();
        HttpResponse<InputStream> res = http.send(req("/api/ai/chat/stream").header("Accept", "text/event-stream").POST(HttpRequest.BodyPublishers.ofString(
                        json.writeValueAsString(Map.of("message", "讲讲特征值", "modelConfigId", withModel, "notebookId", nb, "agentMode", "CHAT_ONLY")))).build(),
                HttpResponse.BodyHandlers.ofInputStream());
        String error = null;
        int deltaChars = 0;
        String event = null;
        try (BufferedReader r = new BufferedReader(new InputStreamReader(res.body(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                if (line.startsWith("event:")) {
                    event = line.substring(6).trim();
                } else if (line.startsWith("data:") && event != null) {
                    JsonNode d = json.readTree(line.substring(5));
                    if (event.equals("error")) error = d.path("message").asText();
                    if (event.equals("message.delta")) deltaChars += d.path("text").asText().length();
                }
            }
        }
        awaitSettled();
        Map<String, Object> row = jdbc.queryForMap(
                "SELECT status, content, error_message, notice FROM ai_message WHERE user_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1", userId);
        String run = jdbc.queryForObject("SELECT status FROM ai_agent_run WHERE user_id = ? ORDER BY id DESC LIMIT 1", String.class, userId);
        JsonNode listed = call(req("/api/ai/messages?notebookId=" + nb).GET().build()).path("data");
        return new Outcome(error, deltaChars, row, listed.get(listed.size() - 1), run);
    }

    Outcome ask(Script script) throws Exception {
        return ask(script, modelId);
    }

    void awaitSettled() throws Exception {
        long deadline = System.currentTimeMillis() + 20_000;
        while (System.currentTimeMillis() < deadline) {
            Integer streaming = jdbc.queryForObject("SELECT COUNT(*) FROM ai_message WHERE user_id = ? AND status = 'STREAMING' AND deleted = 0", Integer.class, userId);
            Integer running = jdbc.queryForObject("SELECT COUNT(*) FROM ai_agent_run WHERE user_id = ? AND status = 'RUNNING'", Integer.class, userId);
            if (streaming == 0 && running == 0) return;
            Thread.sleep(100);
        }
        throw new AssertionError("20 秒后还有回答停在「正在生成」或者执行记录停在 RUNNING");
    }

    /** 失败了：流里、库里、列表里是同一句话，而且这句话里没有不该给用户看的东西。 */
    static void failedWith(Outcome o, String expected) {
        assertEquals("ERROR", o.status(), "应当标成失败：" + o.row());
        assertEquals("ERROR", o.runStatus());
        assertTrue(o.sseError() != null && o.sseError().contains(expected), "流里的那句话：" + o.sseError());
        assertEquals(o.sseError(), o.error(), "库里存的原因要和流里说的一样（刷新之后还在）");
        assertEquals(o.sseError(), o.listed().path("errorMessage").asText(), "列表接口要把原因带回页面");
        for (String leak : List.of("SECRET", "http://", "I/O error", "<html", "Source:", "Exception")) {
            assertFalse(o.sseError().contains(leak), "给用户的话里不该有「" + leak + "」：" + o.sseError());
        }
    }

    void noServerIssues() {
        List<String> issues = jdbc.queryForList("SELECT CONCAT(category, '：', LEFT(message, 160)) FROM runtime_issue WHERE id > ? AND source = 'SERVER'",
                String.class, issuesBefore);
        assertTrue(issues.isEmpty(), "供应商的毛病不该记成我们的运行问题：\n" + String.join("\n", issues));
    }

    @Test
    @DisplayName("key 错（401，报错里还回显了 key）：说「API Key 不对」、key 遮住（原来是「AI 接口调用失败：AI 接口调用失败」）")
    void key错() throws Exception {
        Outcome o = ask(ex -> body(ex, 401, "application/json",
                "{\"error\":{\"message\":\"Incorrect API key provided: " + KEY + ".\",\"type\":\"invalid_request_error\",\"code\":\"invalid_api_key\"}}"));
        failedWith(o, "API Key 不对");
        noServerIssues();
    }

    @Test
    @DisplayName("限流（429 + Retry-After）：说限流了、几秒后再试")
    void 限流() throws Exception {
        Outcome o = ask(ex -> {
            ex.getResponseHeaders().set("Retry-After", "20");
            body(ex, 429, "application/json", "{\"error\":{\"message\":\"Rate limit reached for requests\"}}");
        });
        failedWith(o, "限流");
        assertTrue(o.sseError().contains("20 秒"), o.sseError());
        noServerIssues();
    }

    @Test
    @DisplayName("502 回一整页 nginx 的 HTML：说模型服务暂时出错了，HTML 一个标签都不给用户")
    void 网关502() throws Exception {
        Outcome o = ask(ex -> body(ex, 502, "text/html", "<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body><center>nginx/1.18.0</center></body>\r\n</html>\r\n"));
        failedWith(o, "HTTP 502");
        noServerIssues();
    }

    @Test
    @DisplayName("接口地址填成了官网（200 回一页 HTML）：说地址可能填错了（原来是一条「完成」的空白回答）")
    void 回的是网页() throws Exception {
        Outcome o = ask(ex -> body(ex, 200, "text/html", "<!doctype html><html><head><title>Welcome</title></head><body>Hello</body></html>"));
        failedWith(o, "「接口地址」可能填错了");
    }

    @Test
    @DisplayName("空回答（直接 [DONE]）：说模型什么都没说（原来是一条「完成」的空白回答）")
    void 空回答() throws Exception {
        Outcome o = ask(ex -> {
            sse(ex);
            try (OutputStream out = ex.getResponseBody()) {
                out.write("data: [DONE]\n\n".getBytes(StandardCharsets.UTF_8));
            }
        });
        failedWith(o, "什么都没说");
    }

    @Test
    @DisplayName("说到一半连接断了（没有 [DONE]、没有 finish_reason）：已经出来的那截留着，另说「没说完」（原来半截回答标成完成）")
    void 说到一半断开() throws Exception {
        Outcome o = ask(ex -> {
            sse(ex);
            try (OutputStream out = ex.getResponseBody()) {
                for (int i = 0; i < 3; i++) chunk(out, "第" + i + "段。");
            }
        });
        failedWith(o, "没说完");
        assertEquals("第0段。第1段。第2段。", o.content(), "用户看着出来的半截，刷新之后不能变成空白");
        assertEquals("第0段。第1段。第2段。", o.listed().path("content").asText());
        noServerIssues();
    }

    @Test
    @DisplayName("流里一块 JSON 坏了：说数据格式不对，前面那截留着（原来把接口地址和 Jackson 的解析位置给了用户，正文清空）")
    void 坏JSON() throws Exception {
        Outcome o = ask(ex -> {
            sse(ex);
            try (OutputStream out = ex.getResponseBody()) {
                chunk(out, "开头。");
                out.write("data: {\"choices\":[{\"delta\":{\"content\":\"坏\n\n".getBytes(StandardCharsets.UTF_8));
                chunk(out, "结尾。");
                out.write("data: [DONE]\n\n".getBytes(StandardCharsets.UTF_8));
            }
        });
        failedWith(o, "不是合法的 JSON");
        assertEquals("开头。", o.content());
    }

    @Test
    @DisplayName("回答途中来了一条 error 事件：说途中报错了，前面那截留着")
    void 途中报错() throws Exception {
        Outcome o = ask(ex -> {
            sse(ex);
            try (OutputStream out = ex.getResponseBody()) {
                chunk(out, "开头。");
                out.write("data: {\"error\":{\"message\":\"overloaded\",\"type\":\"server_error\"}}\n\n".getBytes(StandardCharsets.UTF_8));
            }
        });
        failedWith(o, "途中报错");
        assertTrue(o.sseError().contains("overloaded"));
        assertEquals("开头。", o.content());
    }

    @Test
    @DisplayName("被单次输出上限截断（finish_reason=length）：回答照样完成，底下说一句「写到了上限，可以说继续」，刷新之后还在")
    void 输出上限() throws Exception {
        Outcome o = ask(ex -> {
            sse(ex);
            try (OutputStream out = ex.getResponseBody()) {
                chunk(out, "说了很多");
                out.write("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\ndata: [DONE]\n\n".getBytes(StandardCharsets.UTF_8));
            }
        });
        assertEquals("DONE", o.status());
        assertNull(o.sseError());
        assertEquals("说了很多", o.content());
        assertTrue(String.valueOf(o.row().get("notice")).contains("上限"), "库里要存着这句说明：" + o.row());
        assertTrue(o.listed().path("notice").asText().contains("「继续」"), "列表接口要把说明带回页面：" + o.listed());
    }

    @Test
    @DisplayName("完整的回答：不带说明")
    void 完整的回答() throws Exception {
        Outcome o = ask(ex -> {
            sse(ex);
            try (OutputStream out = ex.getResponseBody()) {
                chunk(out, "好的。");
                out.write("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n".getBytes(StandardCharsets.UTF_8));
            }
        });
        assertEquals("DONE", o.status());
        assertEquals("好的。", o.content());
        assertNull(o.row().get("notice"));
        assertTrue(o.listed().path("notice").isNull());
    }

    @Test
    @DisplayName("回了一本书（300 万字）：收到 20 万字就停，推给浏览器的和库里存的一样多，并说只保留了前面（原来 300 万字全推给浏览器、库里悄悄只存 20 万）")
    void 回一本书() throws Exception {
        Outcome o = ask(ex -> {
            sse(ex);
            try (OutputStream out = ex.getResponseBody()) {
                String k = "很长的一段话。".repeat(1000);
                for (int i = 0; i < 430; i++) chunk(out, k);
                out.write("data: [DONE]\n\n".getBytes(StandardCharsets.UTF_8));
            }
        });
        assertEquals("DONE", o.status());
        assertEquals(200_000, o.content().length());
        assertEquals(200_000, o.deltaChars(), "推给浏览器的不该比存下来的多");
        assertTrue(String.valueOf(o.row().get("notice")).contains("太长"), String.valueOf(o.row().get("notice")));
        noServerIssues();
    }

    @Test
    @DisplayName("代理不支持流式、stream:true 也回一整段 JSON：照非流式的格式认出来（原来是一条空白回答）")
    void 回整段JSON() throws Exception {
        Outcome o = ask(ex -> body(ex, 200, "application/json",
                "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"整段回答。\"},\"finish_reason\":\"stop\"}]}"));
        assertEquals("DONE", o.status(), String.valueOf(o.row()));
        assertEquals("整段回答。", o.content());
        assertEquals("整段回答。".length(), o.deltaChars(), "页面上也要看得到");
    }

    @Test
    @DisplayName("连不上（端口没人听）：说连接被拒绝、检查接口地址，不带地址")
    void 连不上() throws Exception {
        int closed;
        try (ServerSocket s = new ServerSocket(0)) {
            closed = s.getLocalPort();
        }
        Outcome o = ask(null, modelConfig("http://127.0.0.1:" + closed + "/v1/chat/completions"));
        failedWith(o, "连接被拒绝");
        noServerIssues();
    }

    @Test
    @DisplayName("坏了一次之后接着问：上一条失败的半截回答不妨碍下一轮（历史里带着它也照样能答）")
    void 坏了之后接着问() throws Exception {
        long nb = call(req("/api/ai/notebooks").POST(HttpRequest.BodyPublishers.ofString("{\"title\":\"接着问\"}")).build()).path("data").path("id").asLong();
        Script cut = ex -> {
            sse(ex);
            try (OutputStream out = ex.getResponseBody()) {
                chunk(out, "半截");
            }
        };
        Script good = ex -> {
            sse(ex);
            try (OutputStream out = ex.getResponseBody()) {
                chunk(out, "这次好了。");
                out.write("data: [DONE]\n\n".getBytes(StandardCharsets.UTF_8));
            }
        };
        for (Script s : List.of(cut, good)) {
            current = s;
            http.send(req("/api/ai/chat/stream").header("Accept", "text/event-stream").POST(HttpRequest.BodyPublishers.ofString(
                    json.writeValueAsString(Map.of("message", "问一下", "modelConfigId", modelId, "notebookId", nb, "agentMode", "CHAT_ONLY")))).build(),
                    HttpResponse.BodyHandlers.ofString());
            awaitSettled();
        }
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT status, content FROM ai_message WHERE user_id = ? AND role = 'assistant' ORDER BY id", userId);
        assertEquals(2, rows.size());
        assertEquals("ERROR", rows.get(0).get("status"));
        assertEquals("半截", rows.get(0).get("content"));
        assertEquals("DONE", rows.get(1).get("status"));
        assertEquals("这次好了。", rows.get(1).get("content"));
        noServerIssues();
    }

    @Test
    @DisplayName("暴力：8 个回答同时进行、模型每个都说到一半断开，一半的人读到第一个字就刷新 —— 8 条都收成「失败 + 半截还在」，没有停在正在生成的")
    void 坏模型之下连发加刷新() throws Exception {
        current = ex -> {
            sse(ex);
            try (OutputStream out = ex.getResponseBody()) {
                chunk(out, "第0段。");
                Thread.sleep(150);
                chunk(out, "第1段。");
            }
        };
        int n = 8;
        List<Long> notebooks = new java.util.ArrayList<>();
        for (int i = 0; i < n; i++) {
            notebooks.add(call(req("/api/ai/notebooks").POST(HttpRequest.BodyPublishers.ofString("{\"title\":\"风暴" + i + "\"}")).build())
                    .path("data").path("id").asLong());
        }
        java.util.concurrent.ExecutorService pool = Executors.newFixedThreadPool(n);
        java.util.concurrent.CyclicBarrier gate = new java.util.concurrent.CyclicBarrier(n);
        try {
            List<java.util.concurrent.Future<?>> all = new java.util.ArrayList<>();
            for (int i = 0; i < n; i++) {
                final long nb = notebooks.get(i);
                final boolean leaveEarly = i % 2 == 0;
                all.add(pool.submit(() -> {
                    gate.await(10, java.util.concurrent.TimeUnit.SECONDS);
                    HttpResponse<InputStream> res = http.send(req("/api/ai/chat/stream").header("Accept", "text/event-stream")
                            .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(Map.of("message", "讲讲特征值",
                                    "modelConfigId", modelId, "notebookId", nb, "agentMode", "CHAT_ONLY")))).build(),
                            HttpResponse.BodyHandlers.ofInputStream());
                    try (BufferedReader r = new BufferedReader(new InputStreamReader(res.body(), StandardCharsets.UTF_8))) {
                        String line;
                        while ((line = r.readLine()) != null) {
                            if (leaveEarly && line.startsWith("event:message.delta")) break;
                        }
                    }
                    return null;
                }));
            }
            for (java.util.concurrent.Future<?> f : all) {
                f.get(60, java.util.concurrent.TimeUnit.SECONDS);
            }
        } finally {
            pool.shutdownNow();
        }
        awaitSettled();
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT status, content, error_message FROM ai_message WHERE user_id = ? AND role = 'assistant' AND deleted = 0", userId);
        assertEquals(n, rows.size());
        for (Map<String, Object> row : rows) {
            assertEquals("ERROR", row.get("status"), String.valueOf(row));
            assertEquals("第0段。第1段。", row.get("content"), "半截要留着：" + row);
            assertTrue(String.valueOf(row.get("error_message")).contains("没说完"), String.valueOf(row));
        }
        noServerIssues();
    }

    /** 原始套接字上读请求体：我们的后端发请求用的是分块编码（没有 Content-Length），两种都要认。 */
    static byte[] requestBody(java.io.InputStream in, String head) throws java.io.IOException {
        java.util.regex.Matcher len = java.util.regex.Pattern.compile("(?i)content-length:\\s*(\\d+)").matcher(head);
        if (len.find()) {
            return in.readNBytes(Integer.parseInt(len.group(1)));
        }
        java.io.ByteArrayOutputStream body = new java.io.ByteArrayOutputStream();
        while (true) {
            StringBuilder size = new StringBuilder();
            int c;
            while ((c = in.read()) != '\n') {
                if (c < 0) return body.toByteArray();
                if (c != '\r') size.append((char) c);
            }
            int n = Integer.parseInt(size.toString().trim(), 16);
            if (n == 0) {
                in.readNBytes(2);
                return body.toByteArray();
            }
            body.write(in.readNBytes(n));
            in.readNBytes(2);
        }
    }

    @Test
    @DisplayName("供应商进程在回答途中崩了（连接硬断，分块没收尾）：和「好好收尾但没说完」一样 —— 半截留着、说没说完（浏览器里实测出来的一种）")
    void 连接硬断() throws Exception {
        try (ServerSocket raw = new ServerSocket(0, 50, java.net.InetAddress.getByName("127.0.0.1"))) {
            Thread server = new Thread(() -> {
                while (!raw.isClosed()) {
                    try (java.net.Socket sock = raw.accept()) {
                        java.io.InputStream in = sock.getInputStream();
                        StringBuilder head = new StringBuilder();
                        while (!head.toString().contains("\r\n\r\n")) head.append((char) in.read());
                        byte[] req = requestBody(in, head.toString());
                        OutputStream out = sock.getOutputStream();
                        if (!new String(req, StandardCharsets.UTF_8).contains("\"stream\":true")) {
                            byte[] b = "{\"choices\":[{\"message\":{\"content\":\"[]\"}}]}".getBytes(StandardCharsets.UTF_8);
                            out.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + b.length + "\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                            out.write(b);
                            continue;
                        }
                        out.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n".getBytes(StandardCharsets.UTF_8));
                        for (String piece : List.of("第0段。", "第1段。")) {
                            byte[] data = ("data: {\"choices\":[{\"delta\":{\"content\":\"" + piece + "\"}}]}\n\n").getBytes(StandardCharsets.UTF_8);
                            out.write((Integer.toHexString(data.length) + "\r\n").getBytes(StandardCharsets.UTF_8));
                            out.write(data);
                            out.write("\r\n".getBytes(StandardCharsets.UTF_8));
                            out.flush();
                        }
                        // 不发结尾的 0 块就关连接：供应商那边进程没了就是这样（JDK 报 Premature EOF）。
                        // 不用 RST（SO_LINGER 0）：那样对端还没读的数据会被协议栈丢掉，测的就成了「半截没收到」
                        Thread.sleep(300);
                    } catch (Exception ignored) {
                        // 关服务器时 accept 抛出：结束
                    }
                }
            });
            server.setDaemon(true);
            server.start();
            Outcome o = ask(null, modelConfig("http://127.0.0.1:" + raw.getLocalPort() + "/v1/chat/completions"));
            failedWith(o, "没说完");
            assertEquals("第0段。第1段。", o.content());
            noServerIssues();
        }
    }
}
