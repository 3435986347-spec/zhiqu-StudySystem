package com.zhiqu.service.ai;

/**
 * 流式正文的<b>节流落库</b>器：让「生成途中刷新页面」看得到已经生成的部分。
 *
 * <h2>它在补的是什么</h2>
 *
 * <p>assistant 消息行在流开始时就建好了（{@code status=STREAMING}、{@code content=""}），
 * 而正文只在整轮最后的事务里写一次。于是生成途中刷新一下，用户看到的是一个空气泡 ——
 * 内容并没有丢，后端还在正常生成，只是这一页再也拿不到它。这个类按节奏把已生成的部分写进去。
 *
 * <h2>为什么节流条件是「时间 且 字数」</h2>
 *
 * <p>每个增量写一次库，一轮几千 token 就是几千次 UPDATE，写的还是一列越来越长的 TEXT ——
 * 代价随长度增长，尾部最贵。只看时间的话，模型卡顿时会把同样的内容反复写回去；
 * 只看字数的话，快速吐字仍会打满数据库。所以两个条件<b>同时</b>满足才写。
 *
 * <h2>写不动了就彻底停手</h2>
 *
 * <p>{@link Writer} 返回 0 意味着这条消息已被清空、或已进入终态（写语句的 WHERE 里带着
 * {@code deleted = 0} 与 {@code status = 'STREAMING'}）。两种情况下继续写都没有意义，
 * 而且后者还会持续与提交事务竞争同一行。所以一旦返回 0 就停，不再尝试 ——
 * 这是「清空必须获胜」（ADR-0002）在这条新写路径上的落实。
 *
 * <h2>失败一律不影响回答</h2>
 *
 * <p>这是一条纯粹的便利路径。它挂了，用户只是失去「刷新还能看到半截」这个能力，
 * 回答本身照常生成、照常在最终事务里完整落库。所以异常在这里被吞掉并停手，
 * 不允许把一次数据库抖动升级成整轮失败。
 */
public final class StreamingContentFlusher {
    /** 两次落库的最小间隔。取 1.5s：足够让刷新拿到「刚刚那几句」，又不至于把库写满。 */
    static final long MIN_INTERVAL_MS = 1_500L;
    /** 两次落库之间至少要多出这么多字，否则不值得为它写一次越来越长的 TEXT 列。 */
    static final int MIN_GROWTH_CHARS = 24;

    /** 真正的写入动作。返回实际更新的行数；0 表示这条消息已被清空或已进终态。 */
    @FunctionalInterface
    public interface Writer {
        int write(String content);
    }

    /** 当前时刻的来源 —— 判据要控制时间，不能等 1.5 秒真实时间过去。 */
    @FunctionalInterface
    public interface Clock {
        long nowMs();
    }

    private final Writer writer;
    private final Clock clock;
    private long lastFlushAt;
    private int lastFlushLength;
    private boolean stopped;

    public StreamingContentFlusher(Writer writer) {
        this(writer, System::currentTimeMillis);
    }

    StreamingContentFlusher(Writer writer, Clock clock) {
        this.writer = writer;
        this.clock = clock;
        this.lastFlushAt = clock.nowMs();
    }

    /** 正文又长了：够久<b>且</b>够多才真的写。 */
    public void onGrew(CharSequence reply) {
        if (stopped
                || reply.length() - lastFlushLength < MIN_GROWTH_CHARS
                || clock.nowMs() - lastFlushAt < MIN_INTERVAL_MS) {
            return;
        }
        write(reply);
    }

    /**
     * 收尾：忽略节流条件写最后一次。
     *
     * <p>最后一段增量距上次 flush 很可能不足节流间隔，不补的话它要等到提交事务才落库，
     * 而那中间还隔着 POST_STREAM 的三次模型往返 —— 正好是刷新最容易发生的那几秒。
     */
    public void flushNow(CharSequence reply) {
        if (stopped || reply.length() == lastFlushLength) {
            return;
        }
        write(reply);
    }

    /** 是否已经停手（消息被清空 / 已进终态 / 写入抛异常）。 */
    public boolean isStopped() {
        return stopped;
    }

    private void write(CharSequence reply) {
        try {
            if (writer.write(reply.toString()) == 0) {
                stopped = true;
                return;
            }
            lastFlushAt = clock.nowMs();
            lastFlushLength = reply.length();
        } catch (Exception e) {
            // 便利路径，不得升级成整轮失败：停手即可，正文仍会在最终事务里完整落库
            stopped = true;
        }
    }
}
