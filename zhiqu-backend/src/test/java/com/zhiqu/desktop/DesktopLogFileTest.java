package com.zhiqu.desktop;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 桌面应用的后端写日志文件（第九十轮）：原生外壳起后端时不接 stdout，日志原来哪儿都不落 ——
 * 评测时网关回了一次 upstream_error（django-15987），到底是供应商回了什么，没处查。
 */
class DesktopLogFileTest {

    @SuppressWarnings("unchecked")
    @Test
    @DisplayName("application-desktop.yml：日志写到 ~/.zhiqu/logs/backend.log（绝对路径：桌面应用的工作目录是 /），按大小滚动、留几份")
    void 日志写文件() throws IOException {
        Map<String, Object> yml = new Yaml().load(Files.readString(
                Path.of("src", "main", "resources", "application-desktop.yml"), StandardCharsets.UTF_8));
        Map<String, Object> logging = (Map<String, Object>) yml.get("logging");
        assertTrue(logging != null, "application-desktop.yml 里没有 logging");
        Map<String, Object> file = (Map<String, Object>) logging.get("file");
        assertEquals("${user.home}/.zhiqu/logs/backend.log", file.get("name"));
        Map<String, Object> rolling = (Map<String, Object>) ((Map<String, Object>) logging.get("logback")).get("rollingpolicy");
        assertEquals("10MB", rolling.get("max-file-size"));
        assertEquals(5, rolling.get("max-history"));
    }
}
