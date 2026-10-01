package com.zhiqu.service.concurrency;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.DefaultRedisScript;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.util.List;
import java.util.UUID;

@Service
public class RedisDistributedLockService {
    private static final DefaultRedisScript<Long> RELEASE_SCRIPT = new DefaultRedisScript<>(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
            Long.class
    );

    private static final Logger log = LoggerFactory.getLogger(RedisDistributedLockService.class);

    private final StringRedisTemplate redisTemplate;
    /**
     * Redis 不可用时退回进程内的锁。原来 Redis 一抛异常，拿锁的地方就跟着抛：早八提醒、到期提醒每一轮都失败，
     * 而桌面版和配置里从没提过要装 Redis —— 在一台没装 Redis 的机器上，提醒一条都发不出去。
     */
    private final LocalExpiringStore local = new LocalExpiringStore();

    public RedisDistributedLockService(StringRedisTemplate redisTemplate) {
        this.redisTemplate = redisTemplate;
    }

    public LockHandle tryLock(String key, Duration ttl) {
        String token = UUID.randomUUID().toString();
        try {
            Boolean acquired = redisTemplate.opsForValue().setIfAbsent(key, token, ttl);
            return Boolean.TRUE.equals(acquired) ? new LockHandle(key, token) : null;
        } catch (RuntimeException e) {
            log.warn("Redis 不可用，锁 {} 退回进程内：{}", key, e.getMessage());
            return local.putIfAbsent(key, token, ttl.toMillis()) ? new LockHandle(key, token, true) : null;
        }
    }

    /**
     * 释放锁<b>不抛异常</b>。它总在 finally 里被调用：这里一抛，前面已经成功的写操作就被报成失败，
     * 调用方一重试就是重复写入。Redis 那边放不掉就等它自己过期。
     */
    public void unlock(LockHandle handle) {
        if (handle == null) {
            return;
        }
        if (handle.local()) {
            local.removeIfValue(handle.key(), handle.token());
            return;
        }
        try {
            redisTemplate.execute(RELEASE_SCRIPT, List.of(handle.key()), handle.token());
        } catch (RuntimeException e) {
            log.warn("Redis 不可用，锁 {} 没能主动释放，等它过期：{}", handle.key(), e.getMessage());
        }
    }

    /** {@code local}：这把锁是 Redis 不可用时在进程内拿的，释放也在进程内。 */
    public record LockHandle(String key, String token, boolean local) {
        public LockHandle(String key, String token) {
            this(key, token, false);
        }
    }
}
