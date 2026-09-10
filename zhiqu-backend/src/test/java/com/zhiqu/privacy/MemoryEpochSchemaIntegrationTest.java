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

/**
 * <b>只测 schema 形状，不测行为。</b>
 *
 * <p>这句话必须写在最前面：本类此前三条断言全绿，而 memory_epoch 在 Java 侧一行都没有 ——
 * 一个名字里带 MemoryEpoch 的绿测试，加上 V27 里那句「最终事务比对本列，不匹配则整体丢弃」，
 * 给了读者两个独立的正向信号，而实际保护为零。判据本身没说谎（类名带 Schema），
 * 但没有任何东西标出「行为侧是空的」。
 *
 * <p>纪元的<b>行为</b>钉在
 * {@code AiConversationLifecycleIntegrationTest.清空记忆之后旧的记忆草稿不得再写入长期记忆()}。
 * 本类绿不代表栅栏生效，那条绿才代表。
 *
 * <p>V32 退掉了 V27 四列里的两列（{@code sys_user.memory_state} 与
 * {@code ai_conversation.revision}），理由见 V32 表头。这里连它们<b>已经消失</b>一起钉住：
 * 只断言留下的两列存在的话，哪天有人把删除迁移回滚了也不会有东西红。
 */
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
    void 接线的两列在_退掉的两列不在() {
        assertEquals(1, columnCount("sys_user", "memory_epoch"),
                "sys_user.memory_epoch 是纪元的来源，clearMemory 递增它");
        assertEquals(1, columnCount("ai_agent_run", "memory_epoch"),
                "ai_agent_run.memory_epoch 是 run 开始时的快照，记忆草稿确认时比对它");

        assertEquals(0, columnCount("sys_user", "memory_state"),
                "memory_state 服务的 Phase 2（blob → facts）已放弃，V32 退掉了它；"
                        + "留着就是承诺一个不存在的 cutover");
        assertEquals(0, columnCount("ai_conversation", "revision"),
                "会话修订号已被 V31 的读侧指纹取代，V32 退掉了它；"
                        + "同一张表上留两套同职责机制、其中一套是死的，是纯粹的误导面");
    }

    /** 两列都必须 NOT NULL DEFAULT 0：可空会让比对逻辑落到 NULL 语义上（现在真有比对逻辑了）。 */
    @Test
    void 纪元列必须非空且默认为零() {
        assertEquals("NO", nullable("sys_user", "memory_epoch"));
        assertEquals("NO", nullable("ai_agent_run", "memory_epoch"));
        assertEquals("0", columnDefault("sys_user", "memory_epoch"));
        assertEquals("0", columnDefault("ai_agent_run", "memory_epoch"));
    }

    private Integer columnCount(String table, String column) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM information_schema.columns " +
                "WHERE table_schema=DATABASE() AND table_name=? AND column_name=?", Integer.class, table, column);
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
