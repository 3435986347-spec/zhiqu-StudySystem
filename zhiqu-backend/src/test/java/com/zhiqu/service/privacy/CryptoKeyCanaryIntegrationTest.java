package com.zhiqu.service.privacy;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfSystemProperty;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 主密钥哨兵（第二十八轮）：好几个后端连同一个库时，主密钥不一致的那个不启动 —— 否则它写进去的密文谁都解不开。
 * 真 MySQL；拿两把不同的主密钥直接调 {@link CryptoKeyCanary#verify}，就是「桌面应用用开发默认值、服务器用生产那把」的情形。
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "app.cookie.secure=false",
        "app.rag.enabled=false"
})
class CryptoKeyCanaryIntegrationTest {

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_canary_test")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    @Autowired private JdbcTemplate jdbc;
    @Autowired private SensitiveCryptoService appCrypto;

    private static final SensitiveCryptoService OTHER = new SensitiveCryptoService("another-master-key-for-the-other-instance-0001");

    @BeforeEach
    void clean() {
        jdbc.update("DELETE FROM ai_conversation WHERE encrypted_summary IS NOT NULL");
    }

    private void restoreCanary() {
        jdbc.update("DELETE FROM crypto_canary");
        CryptoKeyCanary.verify(jdbc, appCrypto);
    }

    @Test
    @DisplayName("启动时真的核过：库里有哨兵，用这个进程的主密钥解得开")
    void 启动时写了哨兵() {
        String canary = jdbc.queryForObject("SELECT encrypted_value FROM crypto_canary WHERE id = 1", String.class);
        assertEquals(CryptoKeyCanary.PLAINTEXT, appCrypto.decrypt(canary));
    }

    @Test
    @DisplayName("同一把主密钥：照常启动；另一把：不启动，并说清楚是主密钥不一致、去哪里配")
    void 另一把主密钥不启动() {
        assertDoesNotThrow(() -> CryptoKeyCanary.verify(jdbc, appCrypto));
        IllegalStateException e = assertThrows(IllegalStateException.class, () -> CryptoKeyCanary.verify(jdbc, OTHER));
        assertTrue(e.getMessage().contains("不是同一把") && e.getMessage().contains("~/.zhiqu/application.yml"), e.getMessage());
    }

    @Test
    @DisplayName("库里还没有哨兵、但已经有别人用另一把写的密文：不启动，也不写哨兵（否则配对了的那台反而起不来）")
    void 没有哨兵时先核已有的密文() {
        try {
            jdbc.update("DELETE FROM crypto_canary");
            jdbc.update("INSERT INTO sys_user(username,password,nickname,role,deleted) VALUES('canary-u','x','c','USER',0)");
            Long user = jdbc.queryForObject("SELECT id FROM sys_user WHERE username='canary-u'", Long.class);
            jdbc.update("INSERT INTO ai_conversation(user_id, encrypted_summary) VALUES(?, ?)", user, appCrypto.encrypt("服务器写的摘要"));

            assertThrows(IllegalStateException.class, () -> CryptoKeyCanary.verify(jdbc, OTHER));
            assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM crypto_canary", Integer.class),
                    "主密钥对不上的实例不许把哨兵写成它那一把");

            assertDoesNotThrow(() -> CryptoKeyCanary.verify(jdbc, appCrypto), "解得开已有密文的那一把照常启动");
            assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM crypto_canary", Integer.class), "并写下哨兵");
        } finally {
            jdbc.update("DELETE FROM ai_conversation WHERE encrypted_summary IS NOT NULL");
            jdbc.update("DELETE FROM sys_user WHERE username='canary-u'");
            restoreCanary();
        }
    }

    @Test
    @DisplayName("全新的库（没有哨兵、没有任何密文）：谁先启动就写下谁的那一把，之后另一把起不来")
    void 新库先到先得() {
        try {
            jdbc.update("DELETE FROM crypto_canary");
            assertEquals(0, CryptoKeyCanary.sampleExisting(jdbc, appCrypto)[0], "这个库里不该还有密文（前提不成立，这条判据就没意义）");
            assertDoesNotThrow(() -> CryptoKeyCanary.verify(jdbc, OTHER));
            assertThrows(IllegalStateException.class, () -> CryptoKeyCanary.verify(jdbc, appCrypto));
        } finally {
            restoreCanary();
        }
    }

    @Test
    @DisplayName("没加密的旧明文不算「解得开」的证据：只抽真是密文的格子")
    void 明文不算数() {
        try {
            jdbc.update("DELETE FROM crypto_canary");
            jdbc.update("INSERT INTO sys_user(username,password,nickname,role,deleted) VALUES('canary-p','x','c','USER',0)");
            Long user = jdbc.queryForObject("SELECT id FROM sys_user WHERE username='canary-p'", Long.class);
            // 每个人每个 conversation_key 只有一段对话（唯一键），两格用两个 key
            jdbc.update("INSERT INTO ai_conversation(user_id, conversation_key, encrypted_summary) VALUES(?, 'plain', ?)", user, "一段没加密的旧摘要");
            jdbc.update("INSERT INTO ai_conversation(user_id, conversation_key, encrypted_summary) VALUES(?, 'cipher', ?)", user, appCrypto.encrypt("加密的"));
            int[] sample = CryptoKeyCanary.sampleExisting(jdbc, OTHER);
            assertEquals(1, sample[0], "明文那一格不该被当成密文抽到");
            assertEquals(0, sample[1]);
        } finally {
            jdbc.update("DELETE FROM ai_conversation WHERE user_id IN (SELECT id FROM sys_user WHERE username='canary-p')");
            jdbc.update("DELETE FROM sys_user WHERE username='canary-p'");
            restoreCanary();
        }
    }

    @Test
    @DisplayName("轮换主密钥时哨兵一起换：不然换完主密钥服务就起不来了")
    void 轮换覆盖哨兵() {
        assertTrue(CryptoKeyRotation.TABLES.stream().anyMatch(t -> "crypto_canary".equals(t.table())
                && t.encryptedColumns().contains("encrypted_value")));
    }
}
