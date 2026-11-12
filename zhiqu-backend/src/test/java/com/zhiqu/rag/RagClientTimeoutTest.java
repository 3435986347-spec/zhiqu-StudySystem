package com.zhiqu.rag;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 建索引和查询用两个读超时（第一百三十二轮）。
 *
 * <p>线上真事：一个 1.5MB 的笔记本资料被切成 704 个父块，每批 8 块推给旁路 —— 一批要现算 24 个向量，
 * 实测 4.7 秒。而当时所有请求共用一个 {@code app.rag.read-timeout-ms: 1800}（那是查询的预算），
 * 于是每一批都在读到响应前被掐断，Spring 把断掉的响应报成
 * {@code Error while extracting response for type [java.util.Map<?, ?>] and content type [application/octet-stream]}，
 * 作业 RETRY 到 DEAD，代次永远停在 BUILDING。块少的资料（2~7 块）碰运气能过，所以这个坑只在「大文件」上显形。
 *
 * <p>这条判据把两个超时钉开：同一个慢旁路（2.5 秒才回），建索引要过得去，查询要按查询预算被掐断。
 */
class RagClientTimeoutTest {

    @Test
    @DisplayName("慢旁路（2.5 秒才回）：建索引过得去，查询仍按查询预算掐断")
    void 建索引的读超时和查询分开() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            try {
                Thread.sleep(2500);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
            byte[] body = "{\"written\":1,\"ok\":true}".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();
        try {
            RagProperties properties = new RagProperties();
            properties.setEnabled(true);
            properties.setServiceToken("test-token");
            properties.setBaseUrl("http://127.0.0.1:" + server.getAddress().getPort());
            properties.setConnectTimeoutMs(500);
            properties.setReadTimeoutMs(800);       // 查询的预算
            properties.setIndexTimeoutMs(10_000);   // 建索引的预算
            RagClient client = new RagClient(properties);

            assertDoesNotThrow(() -> client.indexSource(Map.of("operationId", "probe")),
                    "建索引还在用查询那 0.8 秒 —— 大资料的每一批都会被掐断，代次永远 BUILDING");

            Exception error = assertThrows(Exception.class,
                    () -> client.query(Map.of("requestId", "probe")),
                    "查询没有按查询预算掐断（旁路卡住时请求会一直挂着）");
            String detail = error.getClass().getSimpleName() + "：" + error.getMessage() + " / " + error.getCause();
            assertTrue(detail.contains("timed out") || detail.contains("Read timed out"), "查询不是超时失败的：" + detail);
        } finally {
            server.stop(0);
        }
    }
}
