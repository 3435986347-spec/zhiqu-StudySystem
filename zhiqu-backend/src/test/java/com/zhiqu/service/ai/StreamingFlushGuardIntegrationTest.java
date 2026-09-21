package com.zhiqu.service.ai;

import com.zhiqu.mapper.AiMessageMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfSystemProperty;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

/**
 * 流式正文阶段性落库的三道 WHERE 守卫。
 *
 * <h2>为什么这三条必须走真数据库</h2>
 *
 * <p>守卫全部写在 SQL 的 {@code WHERE} 里（{@code user_id} / {@code status='STREAMING'} /
 * {@code deleted=0}）。任何在 Java 里模拟写入的判据都<b>看不见它们</b> ——
 * 把那三行从 SQL 删掉，单元判据一条都不会红，而行为已经彻底变了。
 *
 * <h2>这条写路径是新开的，而它绕过了既有的保护</h2>
 *
 * <p>系统原本对 assistant 消息只有一次写入：整轮最后的事务，那里有用户锁、有纪元比对
 * （「清空必须获胜」，ADR-0002）。这次为了让刷新能看到半截正文，新增了一条在流线程上、
 * 锁外、事务外的写路径。它天然绕开上面那些保护 —— 所以保护必须在这条 SQL 自己身上重建，
 * 而不是指望别处。这三条判据钉的就是它。
 *
 * <h2>两条并发窗口是真实存在的</h2>
 *
 * <ul>
 *   <li>用户在生成途中清空会话 → 消息被软删，而流还在跑。少了 {@code deleted=0}，
 *       这次写入会把一条已删消息重新填上内容。</li>
 *   <li>最终事务刚写完完整正文并置 DONE，流线程上一次迟到的 flush 才落地。
 *       少了 {@code status='STREAMING'}，它会把完整答案覆盖回半截。</li>
 * </ul>
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "spring.task.scheduling.enabled=false",
        "app.cookie.secure=false",
        "app.rag.enabled=false"
})
class StreamingFlushGuardIntegrationTest {
    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_flush_test")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    private static final String HALF = "写到一半的回答";
    private static final String WHOLE = "写完整了的回答，比半截长得多";

    @Autowired private AiMessageMapper messageMapper;
    @Autowired private JdbcTemplate jdbcTemplate;

    private Long userId;
    private Long messageId;

    @BeforeEach
    void seed() {
        String username = "flush_" + UUID.randomUUID().toString().replace("-", "").substring(0, 16);
        jdbcTemplate.update(
                "INSERT INTO sys_user(username, password, nickname, role, deleted) VALUES (?, ?, ?, 'USER', 0)",
                username, "test-password", "flush");
        userId = jdbcTemplate.queryForObject("SELECT id FROM sys_user WHERE username = ?", Long.class, username);
        jdbcTemplate.update(
                "INSERT INTO ai_conversation(user_id, title, deleted) VALUES (?, '落库判据', 0)", userId);
        Long conversationId = jdbcTemplate.queryForObject("SELECT LAST_INSERT_ID()", Long.class);
        jdbcTemplate.update(
                "INSERT INTO ai_message(user_id, conversation_id, role, content, status, deleted) "
                        + "VALUES (?, ?, 'assistant', '', 'STREAMING', 0)", userId, conversationId);
        messageId = jdbcTemplate.queryForObject("SELECT LAST_INSERT_ID()", Long.class);
    }

    /** 绕过 MyBatis 的逻辑删除过滤直接读原始行 —— 软删之后仍要看得见它的正文。 */
    private String rawContent() {
        return jdbcTemplate.queryForObject(
                "SELECT content FROM ai_message WHERE id = ?", String.class, messageId);
    }

    @Test
    void 生成途中的正文必须真的写进库() {
        assertEquals(1, messageMapper.flushStreamingContent(messageId, userId, HALF),
                "STREAMING 且未删的消息必须能被写入 —— 这是这条路径存在的全部理由");
        assertEquals(HALF, rawContent(),
                "下界：写进去的必须是内容本身。没有这条，下面几条「不得写入」是空过的");
    }

    /**
     * 用户在生成途中清空了会话 —— 这一轮的正文一个字也不该再写回去。
     *
     * <p>扰动：SQL 去掉 {@code AND deleted = 0} → 本条红。
     */
    @Test
    void 已清空的消息不得被后台写入复活() {
        messageMapper.flushStreamingContent(messageId, userId, HALF);
        jdbcTemplate.update("UPDATE ai_message SET deleted = 1 WHERE id = ?", messageId);

        assertEquals(0, messageMapper.flushStreamingContent(messageId, userId, WHOLE),
                "消息已被清空，这次写入必须一行也不影响 —— 返回 0 同时也是让 flusher 停手的信号");
        assertEquals(HALF, rawContent(),
                "「清空必须获胜」（ADR-0002）：清空之后这一轮的内容不得继续往里写。实际：" + rawContent());
    }

    /**
     * 终态消息不得被迟到的 flush 回退成半截。
     *
     * <p>flush 跑在流线程上，完成写发生在提交事务里 —— 两者天然可能错序。
     *
     * <p>扰动：SQL 去掉 {@code AND status = 'STREAMING'} → 本条红。
     */
    @Test
    void 终态消息不得被迟到的落库覆盖() {
        jdbcTemplate.update(
                "UPDATE ai_message SET content = ?, status = 'DONE' WHERE id = ?", WHOLE, messageId);

        assertEquals(0, messageMapper.flushStreamingContent(messageId, userId, HALF),
                "消息已经 DONE，迟到的 flush 必须落空");
        assertEquals(WHOLE, rawContent(),
                "完整答案不得被一次迟到的写入改回半截。实际：" + rawContent());
        assertNotEquals(HALF, rawContent());
    }

    @Test
    void 不得跨用户写入() {
        assertEquals(0, messageMapper.flushStreamingContent(messageId, userId + 999_999L, HALF),
                "写入必须按 user_id 限定，与全仓库其余写路径一致，不靠主键单独定位");
        assertEquals("", rawContent());
    }
}
