package com.zhiqu.config;

import com.zhiqu.SourceText;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.scheduling.config.TaskManagementConfigUtils;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 定时任务的开关是真的开关（第十四轮）。原来测试里写的 {@code spring.task.scheduling.enabled=false} 是 Spring Boot
 * 没有的属性 —— 27 个集成测试以为关了，定时任务其实一直在跑，每次全量测试结束白等 30 秒。
 */
class SchedulingSwitchTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner().withUserConfiguration(SchedulingConfig.class);
    private static final String PROCESSOR = TaskManagementConfigUtils.SCHEDULED_ANNOTATION_PROCESSOR_BEAN_NAME;
    private static final java.util.regex.Pattern ENABLE = java.util.regex.Pattern.compile("@\\s*(?:[\\w$]+\\s*\\.\\s*)*EnableScheduling\\b");

    @Test
    @DisplayName("不配就开着（线上、桌面版照旧发早八提醒、跑索引）")
    void 默认开着() {
        runner.run(ctx -> assertTrue(ctx.containsBean(PROCESSOR), "默认必须开着 —— 否则提醒一条都不发"));
    }

    @Test
    @DisplayName("app.scheduling.enabled=false：一个定时任务都不跑")
    void 关掉就不跑() {
        runner.withPropertyValues("app.scheduling.enabled=false").run(ctx -> assertFalse(ctx.containsBean(PROCESSOR)));
    }

    @Test
    @DisplayName("@EnableScheduling 只在 SchedulingConfig 上：别处再写一个，开关就被绕过了")
    void 只有一处开定时任务() throws Exception {
        List<String> where = new ArrayList<>();
        try (Stream<Path> files = Files.walk(Path.of("src/main/java"))) {
            for (Path f : files.filter(p -> p.toString().endsWith(".java")).toList()) {
                // 全限定名写法（@org.springframework…EnableScheduling）也算 —— 第一版只认短名，扰动时就这样漏过去了
                if (ENABLE.matcher(SourceText.stripComments(Files.readString(f))).find()) where.add(f.getFileName().toString());
            }
        }
        assertEquals(List.of("SchedulingConfig.java"), where);
    }

    @Test
    @DisplayName("测试的连接池不留空闲连接：缓存着的上下文不会在 JVM 退出时往已经停掉的 MySQL 上补连接、把关机拖过 30 秒")
    void 测试连接池不补空闲连接() throws Exception {
        assertTrue(Files.readString(Path.of("src/test/resources/application.properties")).lines()
                .anyMatch(l -> l.trim().equals("spring.datasource.hikari.minimum-idle=0")),
                "去掉它，全量测试结束时又会被 surefire 等满 30 秒强杀（HikariPool.shutdown 等补连接的线程）");
    }

    @Test
    @DisplayName("测试里真的关着，而且没人再写那个不存在的 spring.task.scheduling.enabled")
    void 测试里关着() throws Exception {
        assertTrue(Files.readString(Path.of("src/test/resources/application.properties")).lines()
                .anyMatch(l -> l.trim().equals("app.scheduling.enabled=false")), "测试的 application.properties 要关掉定时任务");
        List<String> phantom = new ArrayList<>();
        try (Stream<Path> files = Files.walk(Path.of("src/test/java"))) {
            for (Path f : files.filter(p -> p.toString().endsWith(".java") && !p.endsWith("SchedulingSwitchTest.java")).toList()) {
                if (SourceText.stripComments(Files.readString(f)).contains("\"spring.task.scheduling.enabled")) phantom.add(f.getFileName().toString());
            }
        }
        assertEquals(List.of(), phantom, "spring.task.scheduling.enabled 不是 Spring Boot 的属性，写了等于没写；用 app.scheduling.enabled");
    }
}
