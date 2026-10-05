package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfSystemProperty;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.autoconfigure.web.ServerProperties;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.io.ByteArrayInputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.stream.Stream;
import java.util.zip.GZIPInputStream;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 慢网下的回包大小（第二十二轮）。Slow 3G（往返 400ms、400kbps）下看板第一次打开要 8.8 秒才能用：zhiqu-api.js 338KB、
 * 看板数据 224KB 都是原样发的 —— 只有 Windows 部署前面的 Caddy 会压，手机直连服务器时一个字节都没省。真 HTTP、真库。
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "app.cookie.secure=false",
        "app.rag.enabled=false"
})
class NetworkCompressionIntegrationTest {

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_network")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @LocalServerPort private int port;
    @Autowired private ServerProperties server;

    private final HttpClient http = HttpClient.newHttpClient();

    private HttpResponse<byte[]> get(String path) throws Exception {
        return http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .header("Accept-Encoding", "gzip").build(), HttpResponse.BodyHandlers.ofByteArray());
    }

    private static byte[] gunzip(byte[] body) throws Exception {
        try (GZIPInputStream in = new GZIPInputStream(new ByteArrayInputStream(body))) {
            return in.readAllBytes();
        }
    }

    @Test
    @DisplayName("页面脚本、页面、接口的 JSON 按 gzip 发，解开和原文一样、小了一大截")
    void 文字类回包是压过的() throws Exception {
        // 第三十七轮起页面脚本是壳 + assets/pages/ 下的模块（壳从 338KB 拆到 115KB，大头在模块里）—— 每一个都要压。
        // 「小了一大截」按总数算：单个小文件、中文多的文件压得没那么狠（专注统计 2.1 倍、壳 2.8 倍），总数是 2.9 倍；
        // 没压（stored）的 gzip 是 1 倍。
        Path assets = Path.of("src/main/resources/static/assets");
        List<Path> scripts = new ArrayList<>();
        for (Path dir : List.of(assets, assets.resolve("pages"))) {
            try (Stream<Path> files = Files.list(dir)) {
                files.filter(f -> f.getFileName().toString().endsWith(".js")).sorted().forEach(scripts::add);
            }
        }
        assertTrue(scripts.size() >= 10, "页面脚本扫到 " + scripts.size() + " 个 —— 扫空了？");
        long originalTotal = 0;
        long sentTotal = 0;
        for (Path script : scripts) {
            String url = "/assets/" + assets.relativize(script).toString().replace('\\', '/') + "?v=x";
            byte[] original = Files.readAllBytes(script);
            HttpResponse<byte[]> js = get(url);
            assertEquals(200, js.statusCode(), url);
            assertEquals("gzip", js.headers().firstValue("Content-Encoding").orElse("（没压）"), url + " 没压");
            assertArrayEquals(original, gunzip(js.body()), url + " 解开之后和原文不一样");
            originalTotal += original.length;
            sentTotal += js.body().length;
        }
        assertTrue(sentTotal * 2 < originalTotal, "页面脚本压完 " + sentTotal + " 字节，原文 " + originalTotal);

        HttpResponse<byte[]> html = get("/dashboard.html");
        assertEquals("gzip", html.headers().firstValue("Content-Encoding").orElse("（没压）"), "页面没压");

        HttpResponse<byte[]> json = get("/v3/api-docs");
        assertEquals(200, json.statusCode());
        assertTrue(json.headers().firstValue("Content-Type").orElse("").startsWith("application/json"));
        assertEquals("gzip", json.headers().firstValue("Content-Encoding").orElse("（没压）"), "接口的 JSON 没压");
    }

    @Test
    @DisplayName("流式回答不压：压缩要攒够一块才发，会把一个字一个字的流憋住")
    void 流不压() {
        assertTrue(server.getCompression().getEnabled());
        assertFalse(Arrays.asList(server.getCompression().getMimeTypes()).contains("text/event-stream"),
                "text/event-stream 在压缩的类型里：" + Arrays.toString(server.getCompression().getMimeTypes()));
    }
}
