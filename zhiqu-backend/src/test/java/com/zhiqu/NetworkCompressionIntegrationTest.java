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
    @DisplayName("静态文件浏览器能存、每次核对（没改过回 304、不带正文）；接口照旧不许存（第一百二十轮：线上 1.5 Mbps，原来每切一页都重下）")
    void 静态文件能被浏览器缓存() throws Exception {
        // 每一类都要有：页面（连同 / 转过去的首页）、壳、页面模块、assets 下的第三方库、vendor 下的、图标、清单
        List<String> paths = List.of("/", "/index.html", "/ai-assistant.html", "/assets/zhiqu-ui.css?v=x", "/assets/zhiqu-api.js",
                "/assets/pages/dashboard.js?v=x", "/assets/vendor/katex/katex.min.js", "/vendor/katex/katex.min.css", "/favicon.ico", "/manifest.json");
        for (String path : paths) {
            HttpResponse<byte[]> first = get(path);
            assertEquals(200, first.statusCode(), path);
            String cache = first.headers().firstValue("Cache-Control").orElse("（没有）");
            assertTrue(cache.contains("no-cache") && cache.contains("private") && !cache.contains("no-store"),
                    path + " 的 Cache-Control 是「" + cache + "」：要让浏览器存着、每次核对；no-store 时带宽小的服务器上每切一页都重下");
            assertFalse(first.headers().firstValue("Expires").isPresent(), path + " 还带着 Expires");
            String lastModified = first.headers().firstValue("Last-Modified").orElse(null);
            assertTrue(lastModified != null, path + " 没有 Last-Modified：浏览器没法核对，只能重下");
            HttpResponse<byte[]> again = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                    .header("Accept-Encoding", "gzip").header("If-Modified-Since", lastModified).build(), HttpResponse.BodyHandlers.ofByteArray());
            assertEquals(304, again.statusCode(), path + " 没改过却又整个发了一遍");
            assertEquals(0, again.body().length, path);
        }
        // 接口是用户的数据：不许存（公开的、要登录的都一样）
        for (String api : List.of("/api/harness/meta", "/api/tasks")) {
            String cache = get(api).headers().firstValue("Cache-Control").orElse("（没有）");
            assertTrue(cache.contains("no-store"), api + " 的 Cache-Control 是「" + cache + "」");
        }
        assertTrue(get("/service-worker.js").headers().firstValue("Cache-Control").orElse("").contains("no-cache"));
    }

    @Test
    @DisplayName("流式回答不压：压缩要攒够一块才发，会把一个字一个字的流憋住")
    void 流不压() {
        assertTrue(server.getCompression().getEnabled());
        assertFalse(Arrays.asList(server.getCompression().getMimeTypes()).contains("text/event-stream"),
                "text/event-stream 在压缩的类型里：" + Arrays.toString(server.getCompression().getMimeTypes()));
    }
}
