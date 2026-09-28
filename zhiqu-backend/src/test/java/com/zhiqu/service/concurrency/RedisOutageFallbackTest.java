package com.zhiqu.service.concurrency;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessClock;
import com.zhiqu.common.Result;
import com.zhiqu.entity.StudyTask;
import com.zhiqu.scheduler.ReminderScheduler;
import com.zhiqu.service.ReminderService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;

import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Redis 连不上时：锁、幂等退回进程内，添加任务和发提醒照常。
 *
 * <p>2026-09-25 实测：Redis 不可用时，任务页「快速添加」（总带着 Idempotency-Key）回的是
 * 「Unable to connect to Redis」，同一个请求不带这个头却能成功；提醒调度拿锁同样直接抛，一条都发不出去。
 * 桌面版和配置里从没提过要装 Redis。
 */
class RedisOutageFallbackTest {

    @SuppressWarnings("unchecked")
    static StringRedisTemplate redisDown() {
        StringRedisTemplate redis = mock(StringRedisTemplate.class);
        ValueOperations<String, String> ops = mock(ValueOperations.class);
        RedisConnectionFailureException down = new RedisConnectionFailureException("Unable to connect to Redis");
        when(redis.opsForValue()).thenReturn(ops);
        when(ops.get(anyString())).thenThrow(down);
        when(ops.setIfAbsent(anyString(), anyString(), any(Duration.class))).thenThrow(down);
        org.mockito.Mockito.doThrow(down).when(ops).set(anyString(), anyString(), any(Duration.class));
        when(redis.delete(anyString())).thenThrow(down);
        when(redis.execute(any(), anyList(), any())).thenThrow(down);
        return redis;
    }

    @Test
    @DisplayName("锁：Redis 挂了退回进程内 —— 拿得到、别人拿不到、放了能再拿")
    void 锁退回进程内() {
        RedisDistributedLockService locks = new RedisDistributedLockService(redisDown());
        RedisDistributedLockService.LockHandle first = locks.tryLock("zhiqu:lock:x", Duration.ofSeconds(30));
        assertNotNull(first, "Redis 挂了就拿不到锁 —— 原来这里直接抛异常");
        assertTrue(first.local());
        assertNull(locks.tryLock("zhiqu:lock:x", Duration.ofSeconds(30)), "同一把锁被拿了两次");
        assertNotNull(locks.tryLock("zhiqu:lock:y", Duration.ofSeconds(30)), "不同的锁互不影响");
        locks.unlock(first);
        assertNotNull(locks.tryLock("zhiqu:lock:x", Duration.ofSeconds(30)), "放了之后拿不回来");
    }

    @Test
    @DisplayName("锁会过期；过期之后原主人再来放锁，不能把后来者的那把放掉")
    void 过期与误放() throws Exception {
        RedisDistributedLockService locks = new RedisDistributedLockService(redisDown());
        RedisDistributedLockService.LockHandle stale = locks.tryLock("k", Duration.ofMillis(30));
        Thread.sleep(60);
        RedisDistributedLockService.LockHandle next = locks.tryLock("k", Duration.ofSeconds(30));
        assertNotNull(next, "过期的锁还占着");
        locks.unlock(stale);
        assertNull(locks.tryLock("k", Duration.ofSeconds(30)), "旧主人把后来者的锁放掉了");
    }

    @Test
    @DisplayName("释放锁不抛异常：它在 finally 里，一抛就把前面已经成功的写报成失败")
    void 放锁不抛() {
        RedisDistributedLockService locks = new RedisDistributedLockService(redisDown());
        assertDoesNotThrow(() -> locks.unlock(new RedisDistributedLockService.LockHandle("k", "t")));
    }

    @Test
    @DisplayName("幂等：Redis 挂了照样去重 —— 同一个键只执行一次、第二次拿到同样的结果；失败的不缓存；不同端点不串")
    void 幂等退回进程内() {
        IdempotencyService idem = new IdempotencyService(redisDown(), new RedisDistributedLockService(redisDown()), new ObjectMapper());
        AtomicInteger runs = new AtomicInteger();
        Result<Integer> first = idem.execute(1L, "task.create", "k-1", () -> Result.success(runs.incrementAndGet()));
        Result<Integer> again = idem.execute(1L, "task.create", "k-1", () -> Result.success(runs.incrementAndGet()));
        assertEquals(1, runs.get(), "同一个 Idempotency-Key 执行了两次（重复建任务）");
        assertEquals(first.getData(), ((Number) again.getData()).intValue());

        idem.execute(1L, "task.createWithRepeat", "k-1", () -> Result.success(runs.incrementAndGet()));
        assertEquals(2, runs.get(), "另一个端点的同名键拿到了别处的结果");

        idem.execute(1L, "task.create", "k-fail", () -> new Result<Integer>(500, "写失败了", null));
        idem.execute(1L, "task.create", "k-fail", () -> Result.success(runs.incrementAndGet()));
        assertEquals(3, runs.get(), "失败的结果被缓存了，重试永远拿到那次失败");
    }

    @Test
    @DisplayName("提醒调度：Redis 挂了照常发（原来拿锁直接抛，一条都发不出去）")
    void 提醒照发() {
        ReminderService reminders = mock(ReminderService.class);
        ReminderScheduler scheduler = new ReminderScheduler(reminders, new RedisDistributedLockService(redisDown()),
                new BusinessClock("Asia/Shanghai"));
        assertDoesNotThrow(scheduler::sendDueTaskReminders);
        assertDoesNotThrow(scheduler::sendDailyDdlReminders);
        verify(reminders, times(1)).processDueTaskReminders(any());
        verify(reminders, times(1)).processDueReminders(any());
    }

    @Test
    @DisplayName("进程内存储不会越长越大：过期的键在超过阈值时被扫掉")
    void 存储会清理() {
        AtomicLong now = new AtomicLong(1_000_000);
        LocalExpiringStore store = new LocalExpiringStore(now::get);
        for (int i = 0; i <= LocalExpiringStore.SWEEP_THRESHOLD; i++) {
            store.put("old-" + i, "v", 1_000);
        }
        now.addAndGet(LocalExpiringStore.SWEEP_INTERVAL_MS + 2_000);
        store.put("fresh", "v", 60_000);
        assertEquals(1, store.size(), "过期的键没被清掉：" + store.size());
        assertEquals("v", store.get("fresh"));
        assertNull(store.get("old-1"));
    }

    @Test
    @DisplayName("任务的密文不进接口回包：页面从不读它，回包却白白多出一倍的文字")
    void 任务回包不带密文() throws Exception {
        StudyTask task = new StudyTask();
        task.setId(1L);
        task.setTitle("复习线代");
        task.setEncryptedTitle("v1:abc:ciphertext");
        task.setEncryptedDescription("v1:def:ciphertext");
        task.setEncryptionVersion("v1");
        String json = new ObjectMapper().findAndRegisterModules().writeValueAsString(task);
        assertTrue(json.contains("复习线代"));
        assertFalse(json.contains("encryptedTitle") || json.contains("encryptedDescription") || json.contains("encryptionVersion")
                || json.contains("ciphertext"), json);
    }
}
