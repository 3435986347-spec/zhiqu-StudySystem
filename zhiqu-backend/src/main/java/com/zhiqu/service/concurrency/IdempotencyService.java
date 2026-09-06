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

    public IdempotencyService(StringRedisTemplate redisTemplate,
                              RedisDistributedLockService lockService,
                              ObjectMapper objectMapper) {
        this.redisTemplate = redisTemplate;
        this.lockService = lockService;
        this.objectMapper = objectMapper;
    }

    @SuppressWarnings("unchecked")
    public <T> Result<T> execute(Long userId, String idempotencyKey, Supplier<Result<T>> supplier) {
        if (idempotencyKey == null || idempotencyKey.isBlank()) {
            return supplier.get();
        }
        String cleanKey = idempotencyKey.trim();
        if (cleanKey.length() > 120) {
            throw new BusinessException("Idempotency-Key 不能超过 120 个字符");
        }
        String base = "zhiqu:idem:" + userId + ":" + cleanKey;
        String resultKey = base + ":result";
        String lockKey = base + ":lock";
        String cached = redisTemplate.opsForValue().get(resultKey);
        if (cached != null) {
            try {
                return (Result<T>) objectMapper.readValue(cached, Result.class);
            } catch (Exception e) {
                redisTemplate.delete(resultKey);
            }
        }

        RedisDistributedLockService.LockHandle lock = lockService.tryLock(lockKey, LOCK_TTL);
        if (lock == null) {
            throw new BusinessException("请求正在处理中，请稍后重试");
        }
        try {
            cached = redisTemplate.opsForValue().get(resultKey);
            if (cached != null) {
                return (Result<T>) objectMapper.readValue(cached, Result.class);
            }
            Result<T> result = supplier.get();
            if (result != null && result.getCode() == 200) {
                redisTemplate.opsForValue().set(resultKey, objectMapper.writeValueAsString(result), RESULT_TTL);
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
}
