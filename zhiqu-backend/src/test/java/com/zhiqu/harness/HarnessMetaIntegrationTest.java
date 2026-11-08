package com.zhiqu.harness;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfSystemProperty;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

/**
 * 真起来的后端（读配置、{@code @Value} 的默认值都走一遍）回的 /api/harness/meta：最新版本是 zhiqu-cli/package.json 的版本。
 * 原来 {@code @Value("${app.harness.cli-latest:0.1.0}")}，单元测试直接 new 控制器照不出来（第一百二十六轮）。
 */
@Testcontainers
@AutoConfigureMockMvc
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "app.cookie.secure=false",
        "app.rag.enabled=false"
})
class HarnessMetaIntegrationTest {

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_meta")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @Autowired private MockMvc mvc;
    @Autowired private ObjectMapper json;

    @Test
    @DisplayName("不登录就能问；cliLatest = zhiqu-cli/package.json 的版本，cliMinimum 还是 0.1.0（旧版照样能用，只是提示更新）")
    void 最新版本跟着命令行() throws Exception {
        JsonNode r = json.readTree(mvc.perform(get("/api/harness/meta"))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8));
        assertEquals(200, r.path("code").asInt(), r.toString());
        assertEquals(CliVersionTest.sourceVersion(), r.path("data").path("cliLatest").asText(), r.toString());
        assertEquals("0.1.0", r.path("data").path("cliMinimum").asText(), r.toString());
    }
}
