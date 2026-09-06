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

import java.sql.SQLException;

@Aspect
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 50)
public class DeadlockRetryAspect {
    @Around("@annotation(retry)")
    public Object retry(ProceedingJoinPoint joinPoint, DeadlockRetry retry) throws Throwable {
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
