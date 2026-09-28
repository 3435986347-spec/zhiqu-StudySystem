package com.zhiqu.service.concurrency;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.common.Result;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.util.function.Supplier;

@Service
public class IdempotencyService {
    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(IdempotencyService.class);
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
        Result<T> hit = readCached(resultKey);
        if (hit != null) {
            return hit;
        }

        RedisDistributedLockService.LockHandle lock = lockService.tryLock(lockKey, LOCK_TTL);
        if (lock == null) {
            throw new BusinessException("请求正在处理中，请稍后重试");
        }
        try {
            hit = readCached(resultKey);
            if (hit != null) {
                return hit;
            }
            // 业务这一步抛什么就原样往外抛，交给 GlobalExceptionHandler：日期写错回 400 说清楚，真的意外记运行问题、
            // 不把原文回给用户。原来这里 catch (Exception) 一律包成 BusinessException(e.getMessage()) —— 于是带着
            // Idempotency-Key 的接口（快速添加任务、套用参考计划、AI 批量建任务）上：日期写错回的是 Java 的原文
            //「Text '2026-02-30' could not be parsed…」，真的服务器 bug 把 SQL / 类名原样回给用户、而且一条运行问题都不记
            //（第十四轮真浏览器里套用参考计划填错日期撞出来的；第十一轮的全接口暴力测试不带这个头，所以没看见）。
            Result<T> result = supplier.get();
            if (result != null && result.getCode() == 200) {
                storeQuietly(resultKey, result);
            }
            return result;
        } finally {
            lockService.unlock(lock);
        }
    }

    /** 缓存里的结果；读不回来（格式坏了）就当没有、删掉。 */
    @SuppressWarnings("unchecked")
    private <T> Result<T> readCached(String resultKey) {
        String cached = cachedResult(resultKey);
        if (cached == null) {
            return null;
        }
        try {
            return (Result<T>) objectMapper.readValue(cached, Result.class);
        } catch (JsonProcessingException e) {
            dropResult(resultKey);
            return null;
        }
    }

    /**
     * 存不进缓存也照样把结果交回去：业务那一步已经做完了，这时候报错，客户端就会以为没成、再发一次 —— 正是幂等要防的重复。
     * 代价只是这一个键失去去重（同键再来会再执行一次），这里记一行日志。
     */
    private void storeQuietly(String resultKey, Result<?> result) {
        try {
            storeResult(resultKey, objectMapper.writeValueAsString(result));
        } catch (JsonProcessingException e) {
            log.warn("幂等结果序列化失败，这个键不再去重：{}", e.getOriginalMessage());
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
