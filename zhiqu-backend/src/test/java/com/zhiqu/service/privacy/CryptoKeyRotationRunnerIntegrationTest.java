package com.zhiqu.service.privacy;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledIfSystemProperty;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.context.ApplicationContext;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.MySQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import javax.sql.DataSource;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 主密钥轮换<b>在真库上</b>真跑一遍：CryptoKeyRotationTest 钉的是纯逻辑，
 * 这里钉 JDBC 那一层 —— SQL 拼接、按批提交、整行写回、以及「有 UNDECRYPTABLE 时
 * 已能轮换的行照样落库、退出码非 0」这条设计。
 *
 * <p>没有 Docker 时显式跳过（{@code -Dzhiqu.skipDockerTests=true}）。
 */
@Testcontainers
@DisabledIfSystemProperty(named = "zhiqu.skipDockerTests", matches = "true",
        disabledReason = "Docker integration tests were explicitly disabled")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.MOCK, properties = {
        "spring.task.scheduling.enabled=false",
        "app.cookie.secure=false",
        "app.rag.enabled=false"
})
class CryptoKeyRotationRunnerIntegrationTest {

    @Container
    @ServiceConnection
    static final MySQLContainer<?> MYSQL = new MySQLContainer<>("mysql:8.0.36")
            .withDatabaseName("zhiqu_rotate_test")
            .withUsername("zhiqu")
            .withPassword("zhiqu");

    private static final String OLD = "old-master-key-0123456789abcdef";
    private static final String NEW = "new-master-key-fedcba9876543210";
    private static final String THIRD = "third-key-never-configured-abcdef";

    @Autowired private JdbcTemplate jdbc;
    @Autowired private DataSource dataSource;
    @Autowired private ApplicationContext context;

    @Test
    void 真库轮换_旧密文转新_明文与坏行不动_退出码反映硬停() {
        AesGcmCipher oldC = new AesGcmCipher(OLD);
        AesGcmCipher newC = new AesGcmCipher(NEW);
        AesGcmCipher thirdC = new AesGcmCipher(THIRD);

        jdbc.update("DELETE FROM sys_user WHERE username='rotate_user'");
        jdbc.update("INSERT INTO sys_user(username, password) VALUES('rotate_user','x')");
        Long uid = jdbc.queryForObject("SELECT id FROM sys_user WHERE username='rotate_user'", Long.class);

        // 四行，四种情况
        long idOld = insertTask(uid, oldC.encrypt("旧密文标题"), oldC.encrypt("旧密文描述"));
        long idPlain = insertTask(uid, "历史明文标题", null);
        long idNew = insertTask(uid, newC.encrypt("已是新key标题"), null);
        long idThird = insertTask(uid, thirdC.encrypt("第三方key标题"), null);

        CryptoKeyRotationRunner runner = new CryptoKeyRotationRunner(dataSource, OLD, NEW, context);
        int code = runner.rotate();

        // 有一行（第三方 key）解不开 → 退出码 1
        assertEquals(1, code, "存在 UNDECRYPTABLE 行时退出码必须非 0，让操作者停下来查");

        // 旧密文那行：现在只有新 key 解得开，内容不变
        String rotatedTitle = jdbc.queryForObject(
                "SELECT encrypted_title FROM study_task WHERE id=?", String.class, idOld);
        assertEquals("旧密文标题", newC.decrypt(rotatedTitle), "旧密文应已用新 key 重加密");
        assertTrue(oldC.tryDecryptCipher(rotatedTitle).isEmpty(), "轮换后不该还能被旧 key 解开");
        String rotatedDesc = jdbc.queryForObject(
                "SELECT encrypted_description FROM study_task WHERE id=?", String.class, idOld);
        assertEquals("旧密文描述", newC.decrypt(rotatedDesc), "同一行的第二个加密列也要轮换");

        // 明文那行：原样保留
        assertEquals("历史明文标题",
                jdbc.queryForObject("SELECT encrypted_title FROM study_task WHERE id=?", String.class, idPlain),
                "明文透传不该被动");

        // 已是新 key 那行：原样保留（幂等）
        String alreadyNew = jdbc.queryForObject(
                "SELECT encrypted_title FROM study_task WHERE id=?", String.class, idNew);
        assertEquals("已是新key标题", newC.decrypt(alreadyNew), "已是新 key 的行内容不该变");

        // 第三方 key 那行：没被动过（既没被新 key 加密、也没损坏）
        String third = jdbc.queryForObject(
                "SELECT encrypted_title FROM study_task WHERE id=?", String.class, idThird);
        assertEquals("第三方key标题", thirdC.decrypt(third), "解不开的行必须原封不动");

        // ── 再跑一次：修好坏行后应当全绿（幂等 + 已轮换的跳过）──
        jdbc.update("UPDATE study_task SET encrypted_title=? WHERE id=?", oldC.encrypt("修好了"), idThird);
        int code2 = new CryptoKeyRotationRunner(dataSource, OLD, NEW, context).rotate();
        assertEquals(0, code2, "坏行修好后重跑应当全绿");
        assertEquals("修好了",
                newC.decrypt(jdbc.queryForObject("SELECT encrypted_title FROM study_task WHERE id=?", String.class, idThird)));
        // 第一轮已轮换的行不该被二次加密
        assertEquals("旧密文标题",
                newC.decrypt(jdbc.queryForObject("SELECT encrypted_title FROM study_task WHERE id=?", String.class, idOld)));

        jdbc.update("DELETE FROM study_task WHERE user_id=?", uid);
        jdbc.update("DELETE FROM sys_user WHERE id=?", uid);
    }

    private long insertTask(Long uid, String encTitle, String encDesc) {
        jdbc.update("INSERT INTO study_task(user_id, title, quadrant, encrypted_title, encrypted_description) "
                + "VALUES(?, ?, ?, ?, ?)", uid, "[encrypted]", 1, encTitle, encDesc);
        return jdbc.queryForObject("SELECT LAST_INSERT_ID()", Long.class);
    }
}
