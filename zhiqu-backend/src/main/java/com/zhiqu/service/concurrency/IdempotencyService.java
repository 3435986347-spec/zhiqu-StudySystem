package com.zhiqu.service.concurrency;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.common.Result;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Supplier;

@Service
public class IdempotencyService {
    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(IdempotencyService.class);
    /**
     * 结果留多久。要比客户端「没弄清就沿用这个键」的窗口（页面、命令行都是放弃之后 10 分钟）加上放弃之前自动重来的那几轮
     * （页面最长约 1.5 分钟、命令行约 3 分钟）还长 —— 这里从做完那一刻算，做完不会早于第一次发出。原来两边都是 10 分钟：
     * 第一下做完、回应丢了、重来几轮才放弃，窗口的最后一截里学生照着「再点一次不会重复保存」再点，服务器已经忘了这个键，又做一遍。
     * IdempotencyLockSpanTest 拿两边的实际常量比。
     */
    static final Duration RESULT_TTL = Duration.ofMinutes(15);
    /**
     * 锁只在进程没了时靠它过期（正常都在 finally 里放掉），所以要比最长的一次写请求还长：原来是 30 秒 —— 正好是页面的超时。
     * 第二十二轮起页面在超时之后用同一个键自动重来，锁要是跟着 30 秒到期，重来的那一下就会和还没做完的那一次<b>同时</b>执行，
     * 写两遍。同步调用模型最长 60 秒、代码工作区的一整轮 5 分钟，取 6 分钟。代价：用着 Redis 时进程被杀，这个键最多 6 分钟里
     * 回「上一次提交还在处理」（没有 Redis 时锁在进程里，跟着进程一起没了）。
     */
    static final Duration LOCK_TTL = Duration.ofMinutes(6);

    private final StringRedisTemplate redisTemplate;
    private final RedisDistributedLockService lockService;
    private final ObjectMapper objectMapper;
    /**
     * 结果还落一份库（第二十二轮，表 idempotency_record）：Redis 里的、进程内的，进程一重启就没了 —— 没有 Redis 时（桌面应用）
     * 回应丢了、等服务起来再点，同一个键新进程不认得，又做一遍（kill -9 重启实测 1 条 → 2 条）。null = 只用 Redis / 进程内（单元测试）。
     */
    private final JdbcTemplate jdbc;
    /**
     * 存下来的回包先加密（Redis、进程内、库里都是密文）。每一个写接口的回包都会存进来，里面有只该出现一次的东西：
     * 新建的个人访问令牌（库里本来只存它的 SHA-256）、管理员重置出来的临时密码、解密后的任务标题和 Wiki 正文（库里本来是密文）。
     * 明文落进 idempotency_record 就是把这些原样写进了库和备份。null = 原样存（只有不落库的单元测试这样构造）。
     */
    private final SensitiveCryptoService crypto;
    private final AtomicLong lastSweep = new AtomicLong();
    /** 一次清理删多少行、最多删几轮：每一轮都走 expires_at 的索引，分批是为了不长时间锁着表。 */
    private static final int SWEEP_BATCH = 1000;
    private static final int SWEEP_MAX_ROUNDS = 50;
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
        this.jdbc = null;
        this.crypto = null;
    }

    /** 落库的一定加密：只有一个带库的构造器，而且它要 crypto。 */
    @Autowired
    public IdempotencyService(StringRedisTemplate redisTemplate,
                              RedisDistributedLockService lockService,
                              ObjectMapper objectMapper,
                              JdbcTemplate jdbc,
                              SensitiveCryptoService crypto) {
        this.redisTemplate = redisTemplate;
        this.lockService = lockService;
        this.objectMapper = objectMapper;
        this.jdbc = jdbc;
        this.crypto = Objects.requireNonNull(crypto, "幂等结果落库必须加密");
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
            throw new com.zhiqu.common.RequestInProgressException("上一次提交还在处理，请稍后再试");
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
                storeQuietly(resultKey, userId, result);
            }
            return result;
        } finally {
            lockService.unlock(lock);
        }
    }

    /** 缓存里的结果；读不回来（格式坏了、解不开）就当没有、删掉。 */
    @SuppressWarnings("unchecked")
    private <T> Result<T> readCached(String resultKey) {
        String cached = cachedResult(resultKey);
        if (cached == null) {
            cached = durableResult(resultKey);
        }
        if (cached == null) {
            return null;
        }
        try {
            return (Result<T>) objectMapper.readValue(unseal(cached), Result.class);
        } catch (JsonProcessingException | RuntimeException e) {
            dropResult(resultKey);
            return null;
        }
    }

    private String seal(String json) {
        return crypto == null ? json : crypto.encrypt(json);
    }

    /** 加密之前存进 Redis 的明文（上线之前那一阵存的）照样认。 */
    private String unseal(String stored) {
        return crypto != null && crypto.isEncrypted(stored) ? crypto.decrypt(stored) : stored;
    }

    /**
     * 存不进缓存也照样把结果交回去：业务那一步已经做完了，这时候报错，客户端就会以为没成、再发一次 —— 正是幂等要防的重复。
     * 代价只是这一个键失去去重（同键再来会再执行一次），这里记一行日志。
     */
    private void storeQuietly(String resultKey, Long userId, Result<?> result) {
        String sealed;
        try {
            sealed = seal(objectMapper.writeValueAsString(result));
        } catch (JsonProcessingException | RuntimeException e) {
            log.warn("幂等结果序列化 / 加密失败，这个键不再去重：{}", e.getMessage());
            return;
        }
        storeResult(resultKey, sealed);
        storeDurably(resultKey, userId, sealed);
    }

    private String durableResult(String resultKey) {
        if (jdbc == null) {
            return null;
        }
        try {
            List<String> rows = jdbc.queryForList("SELECT result_json FROM idempotency_record WHERE key_hash = ? AND expires_at > ?",
                    String.class, crypto.sha256Hex(resultKey), LocalDateTime.now());
            return rows.isEmpty() ? null : rows.get(0);
        } catch (RuntimeException e) {
            log.warn("幂等结果读库失败，当作没有：{}", e.getMessage());
            return null;
        }
    }

    /** 落库失败也照样把结果交回去（同 storeQuietly 的道理）；顺手每 10 分钟清一次过期的。 */
    private void storeDurably(String resultKey, Long userId, String sealed) {
        if (jdbc == null) {
            return;
        }
        LocalDateTime now = LocalDateTime.now();
        try {
            jdbc.update("INSERT INTO idempotency_record(key_hash, user_id, result_json, expires_at) VALUES (?, ?, ?, ?) "
                            + "ON DUPLICATE KEY UPDATE result_json = VALUES(result_json), expires_at = VALUES(expires_at)",
                    crypto.sha256Hex(resultKey), userId, sealed, now.plus(RESULT_TTL));
            long last = lastSweep.get();
            if (System.currentTimeMillis() - last > RESULT_TTL.toMillis() && lastSweep.compareAndSet(last, System.currentTimeMillis())) {
                sweepExpired(now);
            }
        } catch (RuntimeException e) {
            log.warn("幂等结果落库失败，这个键重启之后不再去重：{}", e.getMessage());
        }
    }

    /**
     * 清掉过期的。每个带键的写都插一行，所以不能只删一批：原来每 10 分钟只删 1000 行，写得比每分钟 100 次多，
     * 表就只涨不落（每一行是一整份回包）。这里一批一批删，删不满一批就是删完了；轮数有上限，剩下的下一次接着删。
     */
    int sweepExpired(LocalDateTime now) {
        int total = 0;
        for (int round = 0; round < SWEEP_MAX_ROUNDS; round++) {
            int n = jdbc.update("DELETE FROM idempotency_record WHERE expires_at < ? LIMIT " + SWEEP_BATCH, now);
            total += n;
            if (n < SWEEP_BATCH) {
                break;
            }
        }
        return total;
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
