package com.zhiqu.service.agent;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 同组的 {@code run} 必须<b>真的并发</b>，而宣告与落库必须<b>真的顺序</b>。
 *
 * <h2>并发判据最常见的空形态</h2>
 *
 * <p>只断言「两路结果都在」的话，顺序实现照样满足 —— 那种判据在并发被删掉之后仍然绿。
 * 所以这里比<b>总耗时</b>：两路各睡 300ms，顺序要 600ms 以上，并发应当明显低于它。
 * 时间断言天生有抖动，所以门槛取得很松（低于 500ms 即算并发），
 * 松到不会偶发红，又严到顺序实现必然红。
 *
 * <h2>为什么只有 run 并发</h2>
 *
 * <p>宣告的次序是 UX（用户按顺序看到 agent 上场）；落库要往 AgentRunContext 的缓冲队列写，
 * 那个队列不是并发容器，而且 COMMIT 整段在一个事务里。两者都必须顺序 ——
 * 本类第二、三条判据钉的就是这个，防止以后有人把 parallelGroup 顺手用到那两个时刻上。
 */
class AgentStageConcurrencyTest {

    /** 记录每个时刻的调用顺序与耗时的假 runner。 */
    private static final class SlowRunner implements AgentStageRunner {
        private final String type;
        private final int order;
        private final String group;
        private final long sleepMs;
        private final List<String> log;

        SlowRunner(String type, int order, String group, long sleepMs, List<String> log) {
            this.type = type;
            this.order = order;
            this.group = group;
            this.sleepMs = sleepMs;
            this.log = log;
        }

        @Override public String agentType() { return type; }
        @Override public AgentPosition runAt() { return AgentPosition.at(AgentPhase.PRE_STREAM, order); }
        @Override public String parallelGroup() { return group; }
        @Override public boolean inGraph(AgentRunContext ctx) { return true; }

        @Override public void announce(AgentRunContext ctx) { log.add("announce:" + type); }

        @Override
        public void run(AgentRunContext ctx) {
            log.add("run:" + type);
            try {
                Thread.sleep(sleepMs);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }

        @Override public void commit(AgentRunContext ctx) { log.add("commit:" + type); }
    }

    private static AgentRunContext context() {
        return new AgentRunContext(List.of(), (name, payload) -> { });
    }

    @Test
    void 同组的run必须真的并发() {
        List<String> log = Collections.synchronizedList(new ArrayList<>());
        AgentStageExecutor executor = new AgentStageExecutor(List.of(
                new SlowRunner("A", 10, "research", 300, log),
                new SlowRunner("B", 11, "research", 300, log)));

        long startedAt = System.currentTimeMillis();
        executor.execute(AgentPhase.PRE_STREAM, context(), 2);
        long elapsed = System.currentTimeMillis() - startedAt;

        assertTrue(elapsed < 500,
                "两路各睡 300ms，并发应当明显低于顺序的 600ms；实际 " + elapsed + "ms —— "
                        + "只断言「两路都跑了」的话，顺序实现也满足，那种判据测不到并发");
        assertEquals(2, log.stream().filter(item -> item.startsWith("run:")).count(), "两路都必须真的跑过");
    }

    @Test
    void 并发上限为一时退化为顺序() {
        List<String> log = Collections.synchronizedList(new ArrayList<>());
        AgentStageExecutor executor = new AgentStageExecutor(List.of(
                new SlowRunner("A", 10, "research", 300, log),
                new SlowRunner("B", 11, "research", 300, log)));

        long startedAt = System.currentTimeMillis();
        executor.execute(AgentPhase.PRE_STREAM, context(), 1);
        long elapsed = System.currentTimeMillis() - startedAt;

        assertTrue(elapsed >= 600,
                "上限为 1 时必须退化为顺序，行为与并发前逐字相同；实际 " + elapsed + "ms。"
                        + "这也是上一条的反例：没有它，「永远并发」也能让上一条绿");
    }

    @Test
    void 宣告与落库不得并发() {
        List<String> log = Collections.synchronizedList(new ArrayList<>());
        AgentStageExecutor executor = new AgentStageExecutor(List.of(
                new SlowRunner("A", 10, "research", 0, log),
                new SlowRunner("B", 11, "research", 0, log)));

        executor.execute(AgentPhase.PRE_STREAM, context(), 2);

        // 宣告按位置顺序，落库同理；只有 run 允许乱序
        List<String> announces = log.stream().filter(item -> item.startsWith("announce:")).toList();
        List<String> commits = log.stream().filter(item -> item.startsWith("commit:")).toList();
        assertEquals(List.of("announce:A", "announce:B"), announces,
                "宣告的次序是 UX —— 用户按位置顺序看到 agent 上场，乱序会让执行轨迹读起来像坏了");
        assertEquals(List.of("commit:A", "commit:B"), commits,
                "落库要往非并发的缓冲队列写，而且 COMMIT 整段在一个事务里，必须顺序");
    }

    @Test
    void 并发里的异常必须原样抛出() {
        AtomicInteger ran = new AtomicInteger();
        AgentStageExecutor executor = new AgentStageExecutor(List.of(
                new SlowRunner("A", 10, "research", 0, Collections.synchronizedList(new ArrayList<>())),
                new AgentStageRunner() {
                    @Override public String agentType() { return "B"; }
                    @Override public AgentPosition runAt() { return AgentPosition.at(AgentPhase.PRE_STREAM, 11); }
                    @Override public String parallelGroup() { return "research"; }
                    @Override public boolean inGraph(AgentRunContext ctx) { return true; }
                    @Override public void run(AgentRunContext ctx) {
                        ran.incrementAndGet();
                        throw new IllegalStateException("检索失败");
                    }
                }));

        IllegalStateException thrown = assertThrows(IllegalStateException.class,
                () -> executor.execute(AgentPhase.PRE_STREAM, context(), 2));
        assertEquals("检索失败", thrown.getMessage(),
                "并发里的异常必须原样抛出 —— 包成 ExecutionException 的话，"
                        + "上层按类型分辨错误的地方（比如「是不是校验阻断」）就认不出它了");
        assertEquals(1, ran.get());
    }

    /**
     * 一个组里少一个成员，并发就少一路 —— 而功能判据全绿。
     *
     * <p>POST_STREAM 的三个 runner（记忆草稿 / 计划提取 / 滚动摘要）各自调一次模型，
     * 串行是三次往返相加、并发是取最大值。少拉一个进组，功能上毫无差别，
     * 只是那一路又变回串行 —— 没有判据看着的话，这种退化不会有任何迹象。
     *
     * <p>所以这里钉的是<b>组的成员</b>，而不是「并发机制存在」：机制由上面几条钉。
     */
    @Test
    void 组的成员少一个就退化为串行() {
        List<String> log = Collections.synchronizedList(new ArrayList<>());
        AgentStageExecutor grouped = new AgentStageExecutor(List.of(
                new SlowRunner("A", 10, "post-stream", 300, log),
                new SlowRunner("B", 11, "post-stream", 300, log),
                new SlowRunner("C", 12, "post-stream", 300, log)));

        long startedAt = System.currentTimeMillis();
        grouped.execute(AgentPhase.PRE_STREAM, context(), 3);
        long threeInParallel = System.currentTimeMillis() - startedAt;

        AgentStageExecutor oneLeftOut = new AgentStageExecutor(List.of(
                new SlowRunner("A", 10, "post-stream", 300, log),
                new SlowRunner("B", 11, "post-stream", 300, log),
                new SlowRunner("C", 12, null, 300, log)));   // C 没进组

        startedAt = System.currentTimeMillis();
        oneLeftOut.execute(AgentPhase.PRE_STREAM, context(), 3);
        long oneSequential = System.currentTimeMillis() - startedAt;

        assertTrue(threeInParallel < 500,
                "三路同组应当约 300ms；实际 " + threeInParallel + "ms");
        assertTrue(oneSequential >= 600,
                "漏掉一个成员，那一路就变回串行（约 600ms）；实际 " + oneSequential + "ms —— "
                        + "而功能判据对这种退化毫无反应");
    }
}
