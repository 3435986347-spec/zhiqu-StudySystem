package com.zhiqu.security;

import org.junit.jupiter.api.Test;

import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Redis 挂掉时的降级限流：既要真的限流，也<b>不能只增不减</b>。
 *
 * <h2>泄漏这件事没有功能症状</h2>
 *
 * <p>原实现只有 {@code computeIfAbsent}，一处删除都没有。限流照常工作 —— 每个 key 的窗口
 * 都在正确地修剪时间戳 —— 只是 map 条目本身永远留着。所以任何「限住了没有」的判据
 * 都是绿的，而进程内存随见过的 IP 数单调增长。
 *
 * <p>因此本类里最重要的一条比的是 {@code size()}，不是「有没有被限住」。
 */
class LocalRateWindowsTest {

    private static final long WINDOW_MS = 60_000L;

    private static final class FakeClock {
        private final AtomicLong now = new AtomicLong(1_000_000L);
        long get() { return now.get(); }
        void advance(long ms) { now.addAndGet(ms); }
    }

    @Test
    void 窗口内超过上限必须拦住() {
        FakeClock clock = new FakeClock();
        LocalRateWindows windows = new LocalRateWindows(clock::get);

        for (int i = 0; i < 5; i++) {
            assertTrue(windows.allow("1.2.3.4:api", 5, WINDOW_MS), "前 5 次必须放行，第 " + i + " 次被拦了");
        }
        assertFalse(windows.allow("1.2.3.4:api", 5, WINDOW_MS), "第 6 次必须被拦 —— 这是限流的本体");
    }

    @Test
    void 窗口过去之后必须重新放行() {
        FakeClock clock = new FakeClock();
        LocalRateWindows windows = new LocalRateWindows(clock::get);
        for (int i = 0; i < 5; i++) {
            windows.allow("1.2.3.4:api", 5, WINDOW_MS);
        }
        assertFalse(windows.allow("1.2.3.4:api", 5, WINDOW_MS), "前提：确实已经被限住");

        clock.advance(WINDOW_MS + 1);
        assertTrue(windows.allow("1.2.3.4:api", 5, WINDOW_MS),
                "窗口滑过去之后必须恢复 —— 否则一个 IP 触顶一次就被永久封了");
    }

    @Test
    void 不同key之间互不影响() {
        FakeClock clock = new FakeClock();
        LocalRateWindows windows = new LocalRateWindows(clock::get);
        for (int i = 0; i < 5; i++) {
            windows.allow("1.2.3.4:api", 5, WINDOW_MS);
        }
        assertFalse(windows.allow("1.2.3.4:api", 5, WINDOW_MS));
        assertTrue(windows.allow("5.6.7.8:api", 5, WINDOW_MS),
                "另一个 IP 不该被第一个连累");
        assertTrue(windows.allow("1.2.3.4:auth", 5, WINDOW_MS),
                "同一个 IP 的另一类限流也是独立的桶");
    }

    /**
     * <b>不再来的 key 必须被清掉</b> —— 这是这次修的那个缺陷。
     *
     * <p>扰动：去掉 {@code sweepIfNeeded} 里的 {@code removeIf} → 本条红。
     */
    @Test
    void 不再访问的key必须被清掉() {
        FakeClock clock = new FakeClock();
        LocalRateWindows windows = new LocalRateWindows(clock::get);

        int burst = LocalRateWindows.SWEEP_THRESHOLD + 500;
        for (int i = 0; i < burst; i++) {
            windows.allow("ip-" + i + ":api", 5, WINDOW_MS);
        }
        assertTrue(windows.size() >= LocalRateWindows.SWEEP_THRESHOLD,
                "前提：确实攒够了条目，否则清扫根本不会被触发。实际 " + windows.size());

        // 这些 IP 再也不来了：时间走过一个窗口 + 清扫间隔
        clock.advance(WINDOW_MS + LocalRateWindows.SWEEP_INTERVAL_MS + 1);
        windows.allow("still-here:api", 5, WINDOW_MS);   // 一次访问触发清扫

        assertTrue(windows.size() < 10,
                "一个窗口内没有再来过的 key 必须被清掉，实际还剩 " + windows.size()
                        + " 个 —— 只增不减的话，进程内存随见过的 IP 数单调增长，"
                        + "而限流功能一切正常，没有任何症状");
    }

    /**
     * 清扫不得把<b>仍然活跃</b>的 key 一起扫掉。
     *
     * <p>这是上面那条的反例：没有它，「每次清扫清空整个 map」也能让它绿，
     * 而那等于 Redis 挂掉期间限流完全失效 —— 每次清扫后所有人的计数归零。
     *
     * <h2>时序必须让清扫发生在「active 已经有计数」之后</h2>
     *
     * <p>清扫跑在 {@code allow} 的开头，<b>在本次 key 被写入之前</b>。所以一个 key 的计数
     * 不可能被它自己那一次调用触发的清扫抹掉 —— 必须由<b>之后另一次调用</b>触发的清扫来抹。
     *
     * <p>本判据第一版就栽在这里：先攒一堆过期 key、清一次、再打 active。那次清扫跑在
     * active 存在之前，清完 map 就缩到阈值以下、后续不再清扫，于是「清扫清空一切」
     * 这个扰动<b>是绿的</b>。判据名字说的事它一点都没测到。
     *
     * <p>所以这一版：种下的 key 全部<b>仍在窗口内</b>（只推进清扫间隔，不推进整个窗口），
     * map 因此一直大于阈值；active 先打 3 次，再由另一个 key 触发清扫，然后继续打。
     */
    @Test
    void 清扫不得误伤仍在访问的key() {
        FakeClock clock = new FakeClock();
        LocalRateWindows windows = new LocalRateWindows(clock::get);

        int burst = LocalRateWindows.SWEEP_THRESHOLD + 500;
        for (int i = 0; i < burst; i++) {
            windows.allow("live-" + i + ":api", 5, WINDOW_MS);
        }
        for (int i = 0; i < 3; i++) {
            assertTrue(windows.allow("active:api", 5, WINDOW_MS), "活跃 key 的前 3 次必须放行");
        }

        // 只过清扫间隔，不过窗口：所有 key 都还活着，map 仍然大于阈值
        clock.advance(LocalRateWindows.SWEEP_INTERVAL_MS + 1);
        windows.allow("trigger:api", 5, WINDOW_MS);   // 由别的 key 触发清扫
        assertTrue(windows.size() > LocalRateWindows.SWEEP_THRESHOLD,
                "前提：这一轮的 key 都还在窗口内，清扫不该删掉任何一个。实际剩 " + windows.size()
                        + " 个 —— 少于阈值就说明清扫误删了活跃 key");

        assertTrue(windows.allow("active:api", 5, WINDOW_MS), "第 4 次仍在上限内");
        assertTrue(windows.allow("active:api", 5, WINDOW_MS), "第 5 次仍在上限内");
        assertFalse(windows.allow("active:api", 5, WINDOW_MS),
                "第 6 次必须被拦 —— 拦不住就说明前面那次清扫把 active 的计数抹掉了，"
                        + "而那等于降级期间限流形同虚设");
    }

    @Test
    void 正常负载下不清扫() {
        FakeClock clock = new FakeClock();
        LocalRateWindows windows = new LocalRateWindows(clock::get);
        for (int i = 0; i < 100; i++) {
            windows.allow("ip-" + i + ":api", 5, WINDOW_MS);
        }
        clock.advance(WINDOW_MS * 10);
        windows.allow("another:api", 5, WINDOW_MS);

        assertEquals(101, windows.size(),
                "条目数没到阈值时不该做 O(n) 的清扫 —— 这条钉的是「平时不付这个代价」");
    }
}
