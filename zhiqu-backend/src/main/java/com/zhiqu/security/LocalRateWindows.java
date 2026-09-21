package com.zhiqu.security;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.LongSupplier;

/**
 * Redis 不可用时的进程内滑动窗口限流 —— <b>带清理</b>。
 *
 * <h2>此前它只增不减</h2>
 *
 * <p>原实现只有 {@code computeIfAbsent}，没有任何一处删除：每个出现过的
 * {@code (客户端IP, 限流类型)} 组合永久占住一个 map 条目。窗口内的时间戳会随时间被修剪，
 * <b>但条目本身不会</b> —— 一个 IP 来过一次，它的条目就留到进程重启为止。
 *
 * <p>平时看不出来，因为这条路只在 Redis 抛异常时走。但两种情况下它就是常态：
 * Redis 整个不可用（部署里压根没起 Redis 时，每一次请求都走这里），
 * 以及 Redis 偶发抖动（每次抖动都会给当时活跃的每个 IP 留下一个永久条目）。
 * 公网实例每天被成千上万个扫描 IP 打，于是这是一条稳定的内存泄漏。
 *
 * <h2>为什么是定期清扫而不是「用完就删」</h2>
 *
 * <p>一个条目变成垃圾，是因为那个 IP<b>再也不来了</b> —— 而这件事只能由时间发现，
 * 不可能在它自己的下一次访问里发现（它没有下一次了）。所以必须有一次不由它触发的清扫。
 *
 * <p>清扫在「条目数超过阈值」且「距上次清扫够久」时才做，两个条件都满足才扫，
 * 所以正常负载下它一次都不会跑，而失控时它必然跑。
 *
 * <h2>清扫与计数的竞争</h2>
 *
 * <p>清扫可能删掉一个刚被别的线程取到引用、正要写入的条目，那一次计数就丢了。
 * 这是有意接受的：这条路本身是 Redis 挂掉时的降级，宁可偶尔少算一次，
 * 也不要为它引入一把全局锁。真正的限流精度由 Redis 那条路负责。
 */
public final class LocalRateWindows {
    /** 条目数超过它才考虑清扫。正常负载下（活跃 IP 远少于这个数）永远不会触发。 */
    static final int SWEEP_THRESHOLD = 10_000;
    /** 两次清扫的最小间隔 —— 清扫是 O(n)，不能每个请求都做一遍。 */
    static final long SWEEP_INTERVAL_MS = 10_000L;

    private final ConcurrentHashMap<String, Deque<Long>> windows = new ConcurrentHashMap<>();
    private final LongSupplier clock;
    private final AtomicLong lastSweepAt = new AtomicLong(0L);

    public LocalRateWindows() {
        this(System::currentTimeMillis);
    }

    LocalRateWindows(LongSupplier clock) {
        this.clock = clock;
        this.lastSweepAt.set(clock.getAsLong());
    }

    /** 这次请求是否放行。 */
    public boolean allow(String key, int maxRequests, long windowMs) {
        long now = clock.getAsLong();
        sweepIfNeeded(now, windowMs);
        Deque<Long> window = windows.computeIfAbsent(key, ignored -> new ArrayDeque<>());
        synchronized (window) {
            while (!window.isEmpty() && now - window.peekFirst() > windowMs) {
                window.pollFirst();
            }
            if (window.size() >= maxRequests) {
                return false;
            }
            window.addLast(now);
            return true;
        }
    }

    /** 当前记着多少个 key —— 判据用它看清扫有没有真的发生。 */
    int size() {
        return windows.size();
    }

    private void sweepIfNeeded(long now, long windowMs) {
        if (windows.size() <= SWEEP_THRESHOLD) {
            return;
        }
        long last = lastSweepAt.get();
        if (now - last < SWEEP_INTERVAL_MS || !lastSweepAt.compareAndSet(last, now)) {
            return;   // 还不到时候，或者别的线程已经接手
        }
        windows.entrySet().removeIf(entry -> {
            Deque<Long> window = entry.getValue();
            synchronized (window) {
                Long newest = window.peekLast();
                // 整个窗口都过期了 = 这个 key 在一个窗口内没有再来过
                return newest == null || now - newest > windowMs;
            }
        });
    }
}
