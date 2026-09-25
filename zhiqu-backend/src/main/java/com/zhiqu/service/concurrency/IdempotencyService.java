package com.zhiqu.service.concurrency;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.common.Result;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.util.function.Supplier;

@Service
public class IdempotencyService {
    private static final Duration RESULT_TTL = Duration.ofMinutes(10);
    private static final Duration LOCK_TTL = Duration.ofSeconds(30);

    private final StringRedisTemplate redisTemplate;
    private final RedisDistributedLockService lockService;
    private final ObjectMapper objectMapper;
    /**
     * Redis 不可用时，结果缓存退回进程内。原来 Redis 一抛异常就原样冒出去 —— 任务页的「快速添加」每次都带着
     * Idempotency-Key，于是在没装 Redis 的机器上，添加任务回的是「Unable to connect to Redis」（2026-09-25 实测）；
     * 同一个请求不带这个头却能成功。锁那一半由 {@link RedisDistributedLockService} 自己退回进程内。
     */
    private final LocalExpiringStore local = new LocalExpiringStore();

    public IdempotencyService(StringRedisTemplate redisTemplate,
                              RedisDistributedLockService lockService,
                              ObjectMapper objectMapper) {
        this.redisTemplate = redisTemplate;
        this.lockService = lockService;
        this.objectMapper = objectMapper;
    }

    /**
     * 按 {@code Idempotency-Key} 去重地执行一次写操作。
     *
     * @param scope <b>端点标识，必填。</b>幂等键按约定是 per-endpoint 的：
     *        没有这一维时，同一个 key 发给两个不同端点，第二个会拿到第一个的缓存响应 ——
     *        它的操作根本不会执行，而调用方收到的是一个看起来成功的、属于别处的结果。
     *        <p>刻意要求调用方显式传入，而不是从 {@code HttpServletRequest} 里猜路径：
     *        猜出来的值会随 URL 重构悄悄改变，把「同一个操作」的身份藏进框架细节里。
     */
    @SuppressWarnings("unchecked")
    public <T> Result<T> execute(Long userId, String scope, String idempotencyKey, Supplier<Result<T>> supplier) {
        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            return supplier.get();
        }
        String cleanKey = idempotencyKey.trim();
        if (cleanKey.length() > 120) {
            throw new BusinessException("Idempotency-Key 不能超过 120 个字符");
        }
        if (scope == null || scope.isBlank()) {
            throw new IllegalArgumentException("幂等 scope 不能为空 —— 少了它，不同端点的同名 key 会串味");
        }
        String base = "zhiqu:idem:" + userId + ":" + scope.trim() + ":" + cleanKey;
        String resultKey = base + ":result";
        String lockKey = base + ":lock";
        String cached = cachedResult(resultKey);
        if (cached != null) {
            try {
                return (Result<T>) objectMapper.readValue(cached, Result.class);
            } catch (Exception e) {
                dropResult(resultKey);
            }
        }

        RedisDistributedLockService.LockHandle lock = lockService.tryLock(lockKey, LOCK_TTL);
        if (lock == null) {
            throw new BusinessException("请求正在处理中，请稍后重试");
        }
        try {
            cached = cachedResult(resultKey);
            if (cached != null) {
                return (Result<T>) objectMapper.readValue(cached, Result.class);
            }
            Result<T> result = supplier.get();
            if (result != null && result.getCode() == 200) {
                storeResult(resultKey, objectMapper.writeValueAsString(result));
            }
            return result;
        } catch (BusinessException e) {
            throw e;
        } catch (Exception e) {
            throw new BusinessException(e.getMessage() == null ? "幂等处理失败" : e.getMessage());
        } finally {
            lockService.unlock(lock);
        }
    }

    private String cachedResult(String key) {
        try {
            return redisTemplate.opsForValue().get(key);
        } catch (RuntimeException e) {
            return local.get(key);
        }
    }

    private void storeResult(String key, String value) {
        try {
            redisTemplate.opsForValue().set(key, value, RESULT_TTL);
        } catch (RuntimeException e) {
            local.put(key, value, RESULT_TTL.toMillis());
        }
    }

    private void dropResult(String key) {
        try {
            redisTemplate.delete(key);
        } catch (RuntimeException e) {
            local.remove(key);
        }
    }
}
