package com.zhiqu.desktop;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfSystemProperty;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 下载桌面版（第八十二轮）在真的过滤器链上：落地页上没登录的人也要能下 —— 漏了放行就是 401，
 * 用户在落地页点「下载」什么都拿不到（第五十轮新页面漏了放行是空白 403，同一类）。
 * 顺带量真 Tomcat 上的两件：一百多 MB 的包不被 gzip（压了就没有 Range、白耗 CPU），Range 回 206。
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "app.cookie.secure=false",
        "app.rag.enabled=false"
})
class DesktopDownloadIntegrationTest {

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_downloads")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    private static final Path DIR;
    private static final byte[] DMG = new byte[300_000];

    static {
        for (int i = 0; i < DMG.length; i++) DMG[i] = (byte) (i * 7 + 3);
        try {
            DIR = Files.createTempDirectory("zhiqu-downloads");
            Files.write(DIR.resolve("知趣象限-1.0.0.dmg"), DMG);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    @DynamicPropertySource
    static void downloadsDir(DynamicPropertyRegistry registry) {
        registry.add("app.desktop-downloads-dir", DIR::toString);
    }

    @LocalServerPort private int port;

    private final HttpClient http = HttpClient.newHttpClient();

    private HttpResponse<byte[]> get(String path, String... headers) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path));
        if (headers.length > 0) b.headers(headers);
        return http.send(b.build(), HttpResponse.BodyHandlers.ofByteArray());
    }

    @Test
    @DisplayName("没登录：列表和下载都拿得到；下载不压、是附件；Range 回 206")
    void 没登录也能下() throws Exception {
        HttpResponse<byte[]> list = get("/api/desktop/downloads");
        assertEquals(200, list.statusCode(), "没登录拿列表被拦了（SecurityConfig 漏了放行）");
        Map<?, ?> body = new ObjectMapper().readValue(new String(list.body(), StandardCharsets.UTF_8), Map.class);
        assertEquals(200, body.get("code"));
        assertEquals("知趣象限-1.0.0.dmg", ((Map<?, ?>) ((Map<?, ?>) body.get("data")).get("macos")).get("fileName"));

        HttpResponse<byte[]> dmg = get("/api/desktop/downloads/macos", "Accept-Encoding", "gzip");
        assertEquals(200, dmg.statusCode(), "没登录下载被拦了（SecurityConfig 漏了放行）");
        assertFalse(dmg.headers().firstValue("Content-Encoding").isPresent(), "安装包被 gzip 了");
        assertArrayEquals(DMG, dmg.body(), "下下来的和目录里的不一样");
        assertTrue(dmg.headers().firstValue("Content-Disposition").orElse("").startsWith("attachment;"));
        assertEquals("bytes", dmg.headers().firstValue("Accept-Ranges").orElse(""), "没说能按段下");

        HttpResponse<byte[]> part = get("/api/desktop/downloads/macos", "Range", "bytes=100000-");
        assertEquals(206, part.statusCode(), "断了接着下（Range）没有回 206");
        assertArrayEquals(Arrays.copyOfRange(DMG, 100_000, DMG.length), part.body());
    }

    @Test
    @DisplayName("放行只放这两条：同一段下面别的地址照样要登录；拼路径绕不出下载目录")
    void 放行不放宽() throws Exception {
        int other = get("/api/desktop/other/macos").statusCode();
        assertTrue(other == 401 || other == 403, "/api/desktop 下别的地址没登录也进得去了：" + other);
        for (String sneaky : new String[]{"/api/desktop/downloads/macos/x", "/api/desktop/downloads/..%2F..%2Fetc%2Fpasswd", "/api/desktop/downloads/%2e%2e"}) {
            HttpResponse<byte[]> r = get(sneaky);
            assertNotEquals(200, r.statusCode(), sneaky + " 回了 200");
        }
    }
}
