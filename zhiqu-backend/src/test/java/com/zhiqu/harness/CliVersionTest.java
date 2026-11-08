package com.zhiqu.harness;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.controller.HarnessController;
import com.zhiqu.service.harness.CliRelease;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 服务器告诉命令行的「最新版本」跟着打进 JAR 的那份命令行走（第一百二十六轮）。原来写死 0.1.0：
 * 第一百二十三轮加了子 agent、没发新版，用户装的 0.1.0 里没有子 agent，也永远收不到「有新版本」。
 * 走 Spring 读配置的那一路（{@code @Value} 的默认值）在 {@link HarnessMetaIntegrationTest}。
 */
class CliVersionTest {

    static String sourceVersion() throws Exception {
        return new ObjectMapper().readTree(Files.readString(Path.of("../zhiqu-cli/package.json"))).path("version").asText();
    }

    private static HarnessController controller(String cliLatest) {
        return new HarnessController(null, null, null, null, null, null, null, null, null,
                cliLatest, "0.1.0", new com.zhiqu.service.support.SseHeartbeats(50));
    }

    @Test
    @DisplayName("打进来的那份命令行的版本 = zhiqu-cli/package.json 的版本（不是一个写死的数）")
    void 打进来的版本() throws Exception {
        String source = sourceVersion();
        assertTrue(source.matches("\\d+\\.\\d+\\.\\d+.*"), "package.json 的版本认不出：" + source);
        assertEquals(source, CliRelease.bundledVersion());
    }

    @Test
    @DisplayName("不配 app.harness.cli-latest：meta 说的最新版本就是打进来的那份；配了照配的说")
    void meta的最新版本() throws Exception {
        Map<String, Object> blank = controller("").meta().getData();
        assertNotNull(blank.get("cliLatest"), blank.toString());
        assertEquals(sourceVersion(), blank.get("cliLatest"));
        assertEquals("0.1.0", blank.get("cliMinimum"));
        assertEquals("9.9.9", controller(" 9.9.9 ").meta().getData().get("cliLatest"));
    }
}
