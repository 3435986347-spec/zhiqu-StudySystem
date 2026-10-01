package com.zhiqu.service.concurrency;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.LongSupplier;

/**
 * Redis 不可用时的进程内替身：带过期时间的键值，外加「键不存在才写」（给锁用）。
 *
 * <p>和 {@code LocalRateWindows} 同一个道理：键只会因为「过期了」变成垃圾，而过期的键自己不会再被访问到，
 * 所以清理要靠别的调用触发 —— 超过 {@link #SWEEP_THRESHOLD} 条、且距上次清理超过 {@link #SWEEP_INTERVAL_MS} 才扫一遍，
 * 平时不付 O(n) 的代价。单实例部署（桌面版、没配 Redis 的小服务器）上它就是正确的；多实例没有 Redis 本来就谈不上互斥。
 */
final class LocalExpiringStore {

    static final int SWEEP_THRESHOLD = 10_000;
    static final long SWEEP_INTERVAL_MS = 10_000L;

    private record Entry(String value, long expiresAt) {
        boolean expired(long now) {
            return now >= expiresAt;
        }
    }

    private final ConcurrentHashMap<String, Entry> entries = new ConcurrentHashMap<>();
    private final AtomicLong lastSweepAt = new AtomicLong();
    private final LongSupplier clock;

    LocalExpiringStore() {
        this(System::currentTimeMillis);
    }

    LocalExpiringStore(LongSupplier clock) {
        this.clock = clock;
    }

    String get(String key) {
        long now = clock.getAsLong();
        Entry e = entries.get(key);
        if (e == null) {
            return null;
        }
        if (e.expired(now)) {
            entries.remove(key, e);
            return null;
        }
        return e.value();
    }

    void put(String key, String value, long ttlMs) {
        entries.put(key, new Entry(value, clock.getAsLong() + ttlMs));
        sweepIfNeeded();
    }

    /** 键不存在（或已过期）才写入；写成了返回 true。给锁用。 */
    boolean putIfAbsent(String key, String value, long ttlMs) {
        long now = clock.getAsLong();
        Entry mine = new Entry(value, now + ttlMs);
        Entry result = entries.compute(key, (k, cur) -> cur == null || cur.expired(now) ? mine : cur);
        sweepIfNeeded();
        return result == mine;
    }

    /** 值还是它才删（释放锁时：不能删掉别人后来拿到的那把）。 */
    void removeIfValue(String key, String value) {
        entries.computeIfPresent(key, (k, cur) -> cur.value().equals(value) ? null : cur);
    }

    void remove(String key) {
        entries.remove(key);
    }

    int size() {
        return entries.size();
    }

    private void sweepIfNeeded() {
        if (entries.size() <= SWEEP_THRESHOLD) {
            return;
        }
        long now = clock.getAsLong();
        long last = lastSweepAt.get();
        if (now - last < SWEEP_INTERVAL_MS || !lastSweepAt.compareAndSet(last, now)) {
            return;
        }
        entries.entrySet().removeIf(e -> e.getValue().expired(now));
    }
}
