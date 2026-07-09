package com.zhiqu.service.concurrency;

import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.util.Set;
import java.util.UUID;

@Service
public class RedisRateLimiter {
    private final StringRedisTemplate redisTemplate;

    public RedisRateLimiter(StringRedisTemplate redisTemplate) {
        this.redisTemplate = redisTemplate;
    }

    public boolean allow(String key, int maxRequests, long windowMs) {
        long now = System.currentTimeMillis();
        String redisKey = "zhiqu:rate:" + key;
        String member = now + ":" + UUID.randomUUID();
        long min = now - windowMs;
        redisTemplate.opsForZSet().removeRangeByScore(redisKey, 0, min);
        redisTemplate.opsForZSet().add(redisKey, member, now);
        redisTemplate.expire(redisKey, Duration.ofMillis(windowMs * 2));
        Set<String> current = redisTemplate.opsForZSet().rangeByScore(redisKey, min + 1, now);
        return current == null || current.size() <= maxRequests;
    }
}
