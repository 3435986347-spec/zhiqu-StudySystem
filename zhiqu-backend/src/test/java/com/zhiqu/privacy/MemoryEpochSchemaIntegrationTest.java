package com.zhiqu.privacy;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfSystemProperty;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import static org.junit.jupiter.api.Assertions.assertEquals;

@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "spring.task.scheduling.enabled=false",
        "app.cookie.secure=false",
        "app.rag.enabled=false"
})
class MemoryEpochSchemaIntegrationTest {
    static {
        System.setProperty("api.version", System.getProperty("api.version", "1.40"));
    }

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_epoch_test")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @Autowired private JdbcTemplate jdbc;

    @Test
    void v27SchemaWasApplied() {
        Integer userColumns = jdbc.queryForObject("SELECT COUNT(*) FROM information_schema.columns " +
                "WHERE table_schema=DATABASE() AND table_name='sys_user' " +
                "AND column_name IN ('memory_epoch','memory_state')", Integer.class);
        assertEquals(2, userColumns);

        Integer conversationColumns = jdbc.queryForObject("SELECT COUNT(*) FROM information_schema.columns " +
                "WHERE table_schema=DATABASE() AND table_name='ai_conversation' AND column_name='revision'",
                Integer.class);
        assertEquals(1, conversationColumns);

        Integer runColumns = jdbc.queryForObject("SELECT COUNT(*) FROM information_schema.columns " +
                "WHERE table_schema=DATABASE() AND table_name='ai_agent_run' AND column_name='memory_epoch'",
                Integer.class);
        assertEquals(1, runColumns);

        Integer flagTable = jdbc.queryForObject("SELECT COUNT(*) FROM information_schema.tables " +
                "WHERE table_schema=DATABASE() AND table_name='app_runtime_flag'", Integer.class);
        assertEquals(1, flagTable);
    }

    /**
     * memory_state 的默认值必须是 LEGACY。
     *
     * <p>若此刻就默认 FACTS，本迁移到 Phase 2 之间注册的新用户会被标成 FACTS，
     * 而他们的记忆此时仍写入 user_ai_memory blob——Phase 2 的迁移任务若按 state 枚举
     * 就会漏掉他们，blob 静默丢失。默认值改 FACTS 的动作属于 Phase 2。
     */
    @Test
    void memoryStateDefaultsToLegacyUntilPhaseTwo() {
        String columnDefault = jdbc.queryForObject("SELECT column_default FROM information_schema.columns " +
                "WHERE table_schema=DATABASE() AND table_name='sys_user' AND column_name='memory_state'",
                String.class);
        assertEquals("LEGACY", columnDefault);
    }

    /** 三个栅栏列都必须 NOT NULL DEFAULT 0：可空会让后续的比对逻辑落到 NULL 语义上。 */
    @Test
    void epochColumnsAreNotNullWithZeroDefault() {
        assertEquals("NO", nullable("sys_user", "memory_epoch"));
        assertEquals("NO", nullable("ai_conversation", "revision"));
        assertEquals("NO", nullable("ai_agent_run", "memory_epoch"));
        assertEquals("0", columnDefault("sys_user", "memory_epoch"));
        assertEquals("0", columnDefault("ai_conversation", "revision"));
        assertEquals("0", columnDefault("ai_agent_run", "memory_epoch"));
    }

    private String nullable(String table, String column) {
        return jdbc.queryForObject("SELECT is_nullable FROM information_schema.columns " +
                "WHERE table_schema=DATABASE() AND table_name=? AND column_name=?", String.class, table, column);
    }

    private String columnDefault(String table, String column) {
        return jdbc.queryForObject("SELECT column_default FROM information_schema.columns " +
                "WHERE table_schema=DATABASE() AND table_name=? AND column_name=?", String.class, table, column);
    }
}
