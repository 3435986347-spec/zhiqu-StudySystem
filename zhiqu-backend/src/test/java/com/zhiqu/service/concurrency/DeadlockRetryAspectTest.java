package com.zhiqu.service.concurrency;

import org.aspectj.lang.ProceedingJoinPoint;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DeadlockLoserDataAccessException;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.lang.annotation.Annotation;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 死锁重试只在最外层的事务边界上做（第十四轮）。
 * 里层重试的后果见 {@code ConcurrencyStormIntegrationTest.同时新建}：MySQL 死锁回滚的是整个事务，里层那一段再跑一遍，
 * 外层早被标成 rollback-only，提交时 UnexpectedRollbackException。
 */
class DeadlockRetryAspectTest {

    private final DeadlockRetryAspect aspect = new DeadlockRetryAspect();
    private final DeadlockRetry retry = new DeadlockRetry() {
        @Override public int maxAttempts() { return 3; }
        @Override public long backoffMs() { return 0; }
        @Override public Class<? extends Annotation> annotationType() { return DeadlockRetry.class; }
    };

    @AfterEach
    void clear() {
        TransactionSynchronizationManager.setActualTransactionActive(false);
    }

    /** 前 failures 次抛死锁，之后返回 "ok"。 */
    private ProceedingJoinPoint deadlocking(int failures, AtomicInteger calls) throws Throwable {
        ProceedingJoinPoint jp = mock(ProceedingJoinPoint.class);
        when(jp.proceed()).thenAnswer(inv -> {
            if (calls.incrementAndGet() <= failures) throw new DeadlockLoserDataAccessException("Deadlock found when trying to get lock", null);
            return "ok";
        });
        return jp;
    }

    @Test
    @DisplayName("最外层（还没有事务）：死锁了整个重来，第三次成功就当没事")
    void 最外层重试() throws Throwable {
        AtomicInteger calls = new AtomicInteger();
        assertEquals("ok", aspect.retry(deadlocking(2, calls), retry));
        assertEquals(3, calls.get());
    }

    @Test
    @DisplayName("已经在事务里（被别的 @Transactional 方法调进来）：不重试，死锁原样往外抛给最外层")
    void 里层不重试() throws Throwable {
        TransactionSynchronizationManager.setActualTransactionActive(true);
        AtomicInteger calls = new AtomicInteger();
        ProceedingJoinPoint jp = deadlocking(2, calls);
        assertThrows(DeadlockLoserDataAccessException.class, () -> aspect.retry(jp, retry));
        assertEquals(1, calls.get(), "里层重试等于在一个已经被 MySQL 回滚了的事务里接着跑");
    }
}
