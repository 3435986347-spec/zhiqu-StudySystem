package com.zhiqu.service.concurrency;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.Result;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static com.zhiqu.service.concurrency.RedisOutageFallbackTest.redisDown;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 幂等结果落库的两件事，不用 Docker 也能判（真库的那一份在 IdempotentWriteIntegrationTest）：
 * 落库的是密文；过期的清得完。
 */
class IdempotencyDurableStoreTest {

    /** 只记下 SQL 和参数的 JdbcTemplate：INSERT 的那一行留着，SELECT 时交回去；DELETE 按脚本回删了几行。 */
    static final class RecordingJdbc extends JdbcTemplate {
        final List<Object[]> inserts = new ArrayList<>();
        final List<Integer> deleteScript = new ArrayList<>();
        int deletes;

        @Override
        public int update(String sql, Object... args) {
            if (sql.startsWith("INSERT")) {
                inserts.add(args);
                return 1;
            }
            if (sql.startsWith("DELETE")) {
                deletes++;
                return deleteScript.isEmpty() ? 0 : deleteScript.remove(0);
            }
            throw new AssertionError("没想到的 SQL：" + sql);
        }

        @Override
        @SuppressWarnings("unchecked")
        public <T> List<T> queryForList(String sql, Class<T> elementType, Object... args) {
            for (Object[] row : inserts) {
                if (row[0].equals(args[0])) {
                    return List.of((T) row[2]);
                }
            }
            return List.of();
        }
    }

    private final SensitiveCryptoService crypto = new SensitiveCryptoService("idempotency-durable-store-test-key-0123456789");

    @Test
    @DisplayName("落库的回包是密文：个人访问令牌、临时密码、任务标题这些，库里本来就不存明文；重启之后读回来能解开")
    void 落库的是密文() {
        RecordingJdbc jdbc = new RecordingJdbc();
        String secret = "zqp_" + "s".repeat(40);
        IdempotencyService before = new IdempotencyService(redisDown(), new RedisDistributedLockService(redisDown()), new ObjectMapper(), jdbc, crypto);
        before.execute(1L, "AccessTokenController.create POST /api/access-tokens", "k", () -> Result.success(Map.of("token", secret)));
        assertEquals(1, jdbc.inserts.size());
        String stored = String.valueOf(jdbc.inserts.get(0)[2]);
        assertFalse(stored.contains(secret), "库里存的是明文：" + stored);
        assertTrue(crypto.isEncrypted(stored), "库里存的不是密文：" + stored);
        assertFalse(String.valueOf(jdbc.inserts.get(0)[0]).contains("zqp_"), "键的摘要里不该有原文");

        IdempotencyService restarted = new IdempotencyService(redisDown(), new RedisDistributedLockService(redisDown()), new ObjectMapper(), jdbc, crypto);
        Result<?> again = restarted.execute(1L, "AccessTokenController.create POST /api/access-tokens", "k",
                () -> Result.success(Map.of("token", "第二次不该执行")));
        assertEquals(secret, ((Map<?, ?>) again.getData()).get("token"), "重启之后同一个键：要能解开，交回上一次的结果");
    }

    @Test
    @DisplayName("过期的清得完：每个带键的写都插一行，一次只删一批（1000 行）的话写得多了表只涨不落")
    void 过期的清得完() {
        RecordingJdbc jdbc = new RecordingJdbc();
        jdbc.deleteScript.addAll(List.of(1000, 1000, 500));
        IdempotencyService idem = new IdempotencyService(redisDown(), new RedisDistributedLockService(redisDown()), new ObjectMapper(), jdbc, crypto);
        assertEquals(2500, idem.sweepExpired(LocalDateTime.now()));
        assertEquals(3, jdbc.deletes, "删不满一批就是删完了，不该再多删一轮");

        RecordingJdbc endless = new RecordingJdbc();
        for (int i = 0; i < 1000; i++) {
            endless.deleteScript.add(1000);
        }
        new IdempotencyService(redisDown(), new RedisDistributedLockService(redisDown()), new ObjectMapper(), endless, crypto)
                .sweepExpired(LocalDateTime.now());
        assertTrue(endless.deletes < 1000, "一次清理要有上限，剩下的下一次接着删：删了 " + endless.deletes + " 轮");
    }
}
