package com.zhiqu.service.ai;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 流式正文节流落库：写得够、但不能写太多；写不动了要停手。
 *
 * <h2>为什么节流值得单独钉</h2>
 *
 * <p>这个类存在的唯一理由是「刷新还能看到半截」。把节流条件写错有两个方向，
 * 而两个方向<b>功能上都看不出来</b>：
 *
 * <ul>
 *   <li>太松 —— 每个增量写一次库。一轮几千 token 就是几千次 UPDATE，
 *       写的还是一列越来越长的 TEXT。刷新照样能看到内容，所以没有任何功能判据会红，
 *       只是数据库在流式期间被打满。</li>
 *   <li>太紧 —— 整轮只写一两次。刷新拿到的仍是空的或很旧的内容，
 *       而「有落库机制」这件事本身仍然成立。</li>
 * </ul>
 *
 * <p>所以判据比的是<b>次数</b>，不是「有没有写过」。
 */
class StreamingContentFlusherTest {

    /** 记录每次写入内容的假写入端，并可切换成「拒绝写入」或「抛异常」。 */
    private static final class RecordingWriter implements StreamingContentFlusher.Writer {
        private final List<String> written = new ArrayList<>();
        private int result = 1;
        private RuntimeException failure;

        @Override
        public int write(String content) {
            if (failure != null) {
                throw failure;
            }
            written.add(content);
            return result;
        }
    }

    /** 手动推进的时钟 —— 不能让判据真的等 1.5 秒。 */
    private static final class FakeClock implements StreamingContentFlusher.Clock {
        private final AtomicLong now = new AtomicLong(1_000_000L);
        @Override public long nowMs() { return now.get(); }
        void advance(long ms) { now.addAndGet(ms); }
    }

    private static String text(int chars) {
        return "字".repeat(chars);
    }

    @Test
    void 够久且够多才写() {
        RecordingWriter writer = new RecordingWriter();
        FakeClock clock = new FakeClock();
        StreamingContentFlusher flusher = new StreamingContentFlusher(writer, clock);

        // 字够了但时间不够
        flusher.onGrew(text(100));
        assertEquals(0, writer.written.size(), "距上次落库还不到 1.5s，不该写 —— 否则快速吐字会把库打满");

        // 时间够了，字也够了
        clock.advance(1_600);
        flusher.onGrew(text(100));
        assertEquals(1, writer.written.size(), "两个条件都满足时必须写");
        assertEquals(text(100), writer.written.get(0), "写进去的必须是当前已生成的全文");

        // 时间够了但字不够（只多了 5 个）
        clock.advance(5_000);
        flusher.onGrew(text(105));
        assertEquals(1, writer.written.size(),
                "只多了 5 个字不值得重写一列越来越长的 TEXT；只看时间的话，模型卡顿时会反复写同样的内容");

        clock.advance(5_000);
        flusher.onGrew(text(200));
        assertEquals(2, writer.written.size(), "字终于够了，该写");
    }

    /**
     * 一轮下来写的次数必须远少于增量数 —— 这条是「太松」那个方向的判据。
     *
     * <p>模拟 1200 个增量、每个 3 字、每个间隔 20ms（合计 24 秒）。
     * 按 1.5s 的间隔，上限是 24/1.5 ≈ 16 次。
     */
    @Test
    void 一轮的落库次数必须远少于增量数() {
        RecordingWriter writer = new RecordingWriter();
        FakeClock clock = new FakeClock();
        StreamingContentFlusher flusher = new StreamingContentFlusher(writer, clock);

        StringBuilder reply = new StringBuilder();
        for (int i = 0; i < 1200; i++) {
            reply.append("字字字");
            clock.advance(20);
            flusher.onGrew(reply);
        }
        assertTrue(writer.written.size() <= 20,
                "1200 个增量最多该落库 20 次左右（24s / 1.5s），实际 " + writer.written.size()
                        + " 次 —— 每个增量都写就是几千次 UPDATE，而功能判据对此毫无反应");
        assertTrue(writer.written.size() >= 10,
                "另一头：整轮只写 " + writer.written.size() + " 次的话，刷新拿到的内容会很旧。"
                        + "没有这条下界，「几乎不写」也能让上面那条绿");
    }

    @Test
    void 收尾必须补写最后一截() {
        RecordingWriter writer = new RecordingWriter();
        FakeClock clock = new FakeClock();
        StreamingContentFlusher flusher = new StreamingContentFlusher(writer, clock);

        clock.advance(2_000);
        flusher.onGrew(text(50));
        assertEquals(1, writer.written.size());

        // 最后一段增量距上次落库不到 1.5s —— 节流会挡住它
        clock.advance(300);
        flusher.onGrew(text(80));
        assertEquals(1, writer.written.size(), "前提：节流确实挡住了它，否则下面这条是空过的");

        flusher.flushNow(text(80));
        assertEquals(2, writer.written.size(), "收尾必须忽略节流写最后一次");
        assertEquals(text(80), writer.written.get(1));

        // 没有新内容时收尾不该白写一次
        flusher.flushNow(text(80));
        assertEquals(2, writer.written.size(), "内容没变就不必再写");
    }

    /**
     * 写入端返回 0 表示消息已被清空或已进终态 —— 必须<b>彻底</b>停手。
     *
     * <p>这是「清空必须获胜」（ADR-0002）在这条新写路径上的落实：用户在生成途中清空了会话，
     * 这条消息已被软删，那么这一轮剩下的正文一个字也不该再写回去。
     * 继续尝试还会持续与提交事务竞争同一行。
     */
    @Test
    void 写不动之后不得再尝试() {
        RecordingWriter writer = new RecordingWriter();
        FakeClock clock = new FakeClock();
        StreamingContentFlusher flusher = new StreamingContentFlusher(writer, clock);

        writer.result = 0;   // 消息已被清空 / 已进终态
        clock.advance(2_000);
        flusher.onGrew(text(50));
        assertEquals(1, writer.written.size(), "第一次还不知道，试一次是应该的");
        assertTrue(flusher.isStopped(), "返回 0 之后必须标记为停手");

        writer.result = 1;   // 就算写入端又「好了」，也不该再写
        clock.advance(10_000);
        flusher.onGrew(text(500));
        flusher.flushNow(text(900));
        assertEquals(1, writer.written.size(),
                "停手之后一次都不该再写 —— 用户已经清空了会话，这一轮的正文不得再写回去");
    }

    @Test
    void 写入抛异常不得升级成整轮失败() {
        RecordingWriter writer = new RecordingWriter();
        FakeClock clock = new FakeClock();
        StreamingContentFlusher flusher = new StreamingContentFlusher(writer, clock);
        writer.failure = new IllegalStateException("连接池炸了");

        clock.advance(2_000);
        flusher.onGrew(text(50));      // 不抛出去就算通过
        flusher.flushNow(text(90));

        assertTrue(flusher.isStopped(),
                "这是便利路径：数据库抖一下只该让「刷新看到半截」失效，不该把整轮回答打挂");
        assertFalse(writer.written.contains(text(50)), "抛异常的那次当然没写成");
    }
}
