package com.zhiqu.service.concurrency;

import org.aspectj.lang.ProceedingJoinPoint;
import org.aspectj.lang.annotation.Around;
import org.aspectj.lang.annotation.Aspect;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.dao.CannotAcquireLockException;
import org.springframework.dao.DeadlockLoserDataAccessException;
import org.springframework.dao.TransientDataAccessResourceException;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.sql.SQLException;

@Aspect
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 50)
public class DeadlockRetryAspect {
    @Around("@annotation(retry)")
    public Object retry(ProceedingJoinPoint joinPoint, DeadlockRetry retry) throws Throwable {
        // 只在最外层的事务边界上重试。已经在一个事务里（被另一个 @Transactional 方法调进来）时，重试这一段没有意义而且有害：
        // 死锁时 MySQL 回滚的是<b>整个</b>事务，外面那一段已经没了，里面这一段再跑一遍也救不回来 —— Spring 早把事务标成
        // rollback-only，提交时抛 UnexpectedRollbackException，用户看到「服务器出错了」。
        // 第十四轮真浏览器里双击「创建例行计划」撞出来的：新建（带重试）→ 成就检查（也带重试），两个请求同时解锁同一个成就就死锁。
        // 交给最外层：异常原样往外抛，外层把整个事务从头再来。
        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            return joinPoint.proceed();
        }
        int attempts = Math.max(1, retry.maxAttempts());
        long backoff = Math.max(0, retry.backoffMs());
        Throwable last = null;
        for (int i = 1; i <= attempts; i++) {
            try {
                return joinPoint.proceed();
            } catch (Throwable e) {
                last = e;
                if (i >= attempts || !isRetryable(e)) {
                    throw e;
                }
                Thread.sleep(backoff * i);
            }
        }
        throw last;
    }

    private boolean isRetryable(Throwable e) {
        if (e instanceof DeadlockLoserDataAccessException
                || e instanceof CannotAcquireLockException
                || e instanceof TransientDataAccessResourceException) {
            return true;
        }
        Throwable cursor = e;
        while (cursor != null) {
            if (cursor instanceof SQLException sqlException) {
                int code = sqlException.getErrorCode();
                if (code == 1213 || code == 1205) {
                    return true;
                }
            }
            String message = cursor.getMessage();
            if (message != null) {
                String lower = message.toLowerCase();
                if (lower.contains("deadlock") || lower.contains("lock wait timeout")) {
                    return true;
                }
            }
            cursor = cursor.getCause();
        }
        return false;
    }
}
