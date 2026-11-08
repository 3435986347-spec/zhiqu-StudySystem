package com.zhiqu.rag;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfSystemProperty;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 第一百二十四轮：RAG 的「默认启动」—— 一个启用的索引都没有时，自己往前推：对账 → 建 → 启用。
 * 真库、真 worker、照真旁路回包写的桩（index 回 written、delete 回 deleted、meta 回 ready 和 indexVersion）。
 *
 * <p>线上的样子：Wiki 页写的时候 RAG 关着，投影表是空的；点过两次重建，建出来的是两个空索引、一个都没启用。
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "app.cookie.secure=false"
})
class RagBootstrapIntegrationTest {

    private static final String INDEX_VERSION = "bge-small-zh-v1.5@bootstrap";
    private static final HttpServer SIDECAR;
    private static final int SIDECAR_PORT;
    private static final AtomicInteger INDEXED = new AtomicInteger();

    static {
        try {
            SIDECAR = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            SIDECAR_PORT = SIDECAR.getAddress().getPort();
            SIDECAR.createContext("/v1/meta", exchange ->
                    respond(exchange, "{\"ready\":true,\"indexVersion\":\"" + INDEX_VERSION + "\",\"metric\":\"cosine\"}"));
            SIDECAR.createContext("/v1/index/sources", exchange -> {
                String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
                Matcher chunks = Pattern.compile("\"chunkId\"").matcher(body);
                int written = 0;
                while (chunks.find()) written++;
                INDEXED.addAndGet(written);
                respond(exchange, "{\"written\":" + written + ",\"skipped\":false,\"indexVersion\":\"" + INDEX_VERSION + "\"}");
            });
            SIDECAR.createContext("/v1/index/delete", exchange -> respond(exchange, "{\"deleted\":0,\"scope\":\"UNIT\"}"));
            SIDECAR.start();
        } catch (IOException e) {
            throw new IllegalStateException("桩旁路启动失败", e);
        }
    }

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_rag_bootstrap")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @DynamicPropertySource
    static void sidecarProperties(DynamicPropertyRegistry registry) {
        registry.add("app.rag.enabled", () -> true);
        registry.add("app.rag.service-token", () -> "bootstrap-token");
        registry.add("app.rag.base-url", () -> "http://127.0.0.1:" + SIDECAR_PORT);
        registry.add("app.rag.index-version", () -> INDEX_VERSION);
    }

    @Autowired private JdbcTemplate jdbc;
    @Autowired private RagAdminService admin;
    @Autowired private RagIndexWorker worker;

    private String status(long id) {
        return jdbc.queryForObject("SELECT status FROM rag_index_generation WHERE id=?", String.class, id);
    }

    private void drain() {
        for (int i = 0; i < 40; i++) worker.run();
    }

    @Test
    @DisplayName("线上的样子：Wiki 页在、投影表空、两个空索引一个都没启用 → 对账、建、启用；启用之后不再动；旁路没准备好时不建")
    void 自己往前推() {
        String suffix = UUID.randomUUID().toString().replace("-", "");
        jdbc.update("INSERT INTO sys_user(username,password,nickname,role,deleted) VALUES(?,?,?,'USER',0)", "boot_" + suffix, "test-password", "Boot");
        Long userId = jdbc.queryForObject("SELECT id FROM sys_user WHERE username=?", Long.class, "boot_" + suffix);
        for (String title : new String[] {"四象限", "周计划"}) {
            jdbc.update("INSERT INTO user_knowledge_page(user_id,page_type,title,encrypted_content,encryption_version,version,sort_order,pinned,deleted) "
                    + "VALUES(?,'NOTE',?,?,'v0',0,0,0,0)", userId, title, title + "的正文：重要不紧急的事排进日程。");
        }
        // 线上点过两次的重建：建好了，可里面什么都没有（那时还没对账）
        for (int i = 0; i < 2; i++) {
            jdbc.update("INSERT INTO rag_index_generation(index_version,collection_name,status,expected_source_count,indexed_source_count) "
                    + "VALUES(?,?,'READY',0,0)", INDEX_VERSION, "stale_" + i + "_" + suffix);
        }
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM rag_indexable_unit", Integer.class), "投影表一开始是空的");

        assertEquals("reconcile", admin.bootstrapStep(true), "投影表空、库里有 Wiki 页：先对账");
        assertEquals("reconciling", admin.bootstrapStep(true), "对账还在途：等");
        drain();
        assertEquals(2, jdbc.queryForObject("SELECT COUNT(*) FROM rag_indexable_unit WHERE namespace='WIKI_PAGE'", Integer.class), "对账之后两页进了投影表");

        // 那两个空索引对账之后还是 0 / 0（覆盖不上，启用会被拒）：要建新的 —— 旁路没准备好时不建
        assertEquals("sidecar-not-ready", admin.bootstrapStep(false));
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM rag_index_generation WHERE status='BUILDING'", Integer.class), "旁路没准备好不该建");
        String step = admin.bootstrapStep(true);
        assertTrue(step.startsWith("rebuild #"), "那两个空索引覆盖不上：建个新的。实际：" + step);
        long rebuilt = Long.parseLong(step.substring("rebuild #".length()));
        assertEquals("building", admin.bootstrapStep(true), "在建：等");
        drain();
        assertEquals("READY", status(rebuilt));
        assertTrue(INDEXED.get() >= 2, "旁路收到了两页：" + INDEXED.get());
        assertEquals("activated #" + rebuilt, admin.bootstrapStep(true));
        assertEquals("ACTIVE", status(rebuilt));
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM rag_index_generation WHERE status='ACTIVE'", Integer.class), "只启用一个");
        assertEquals("active", admin.bootstrapStep(true), "已经有在用的：什么都不做");

        // 已经有在用的：之后建好的新代次照旧 READY，换不换由管理员决定
        jdbc.update("INSERT INTO rag_index_generation(index_version,collection_name,status,expected_source_count,indexed_source_count) "
                + "VALUES(?,?,'READY',2,2)", INDEX_VERSION, "later_" + suffix);
        Long later = jdbc.queryForObject("SELECT id FROM rag_index_generation WHERE collection_name=?", Long.class, "later_" + suffix);
        assertEquals("active", admin.bootstrapStep(true));
        assertEquals("READY", status(later), "有在用的就不自动换");
    }

    private static void respond(HttpExchange exchange, String body) throws IOException {
        byte[] payload = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/json");
        exchange.sendResponseHeaders(200, payload.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(payload);
        }
    }
}
