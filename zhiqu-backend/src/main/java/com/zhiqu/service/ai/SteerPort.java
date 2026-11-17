package com.zhiqu.service.ai;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import java.util.function.Predicate;

/**
 * 网页代码模式里，后端往宿主（code-host.js）递「用户干活中途补的话」的口子（第一百五十二轮，docs/steer-plan.md 第 3 步）。
 *
 * <p>一轮回答一个，三段：
 * <ol>
 *   <li>宿主起来之前（代码 agent 前面那几步、起 node 那一会儿）：补的话先收在这里（{@link #say} 返回 true）。</li>
 *   <li>{@link #start}：把收着的这些随 run 消息一起交给宿主，并挂上真正去说的函数 —— 两件事在同一把锁里，
 *       中间不会有一句话既没进 run、也没走 say。</li>
 *   <li>之后 {@link #say} 直接说给宿主（锁外等它的 say_ack）。{@link #finish} 之后一律 false。</li>
 * </ol>
 *
 * <p>收尾时谁都没收走的话 {@link #unconsumed()}：宿主起来过就是它交回的 leftover，没起来（没有代码意图、找不到 node）就是收着的那些 ——
 * 一个字都不能丢，调用方交给最终回答那一步（用得上就用，用不上就告诉页面「排到下一轮」）。
 */
public final class SteerPort {

    private final List<String> held = new ArrayList<>();
    private final List<String> leftover = new ArrayList<>();
    private Predicate<String> sink;
    private boolean started;
    private boolean finished;

    public SteerPort(List<String> initial) {
        if (initial != null) {
            held.addAll(initial);
        }
    }

    /**
     * 宿主起来了：sendRun 拿着收着的话去发 run 消息，之后的话走 sink。
     * 发 run 是往管子里写一行，很快；在锁里做，这一刻到的 say 等它写完再走 sink（宿主那头先收到 run、再收到 say）。
     */
    public synchronized void start(Consumer<List<String>> sendRun, Predicate<String> sink) {
        List<String> initial = List.copyOf(held);
        held.clear();
        started = true;
        sendRun.accept(initial);
        this.sink = sink;
    }

    /** 宿主收尾了。leftover：它交回的没读到的原话 */
    public synchronized void finish(List<String> leftover) {
        this.sink = null;
        this.finished = true;
        if (leftover != null) {
            this.leftover.addAll(leftover);
        }
    }

    /**
     * 补一句。不在锁里等宿主的回音（调用方是 HTTP 线程，回音由读宿主输出的那个线程交过来）。
     *
     * @return true = 收下了（宿主还没起来时收在这里，起来后是宿主收进了这一轮的收件箱）；false = 已经收尾 / 宿主没收下
     */
    public boolean say(String text) {
        Predicate<String> s;
        synchronized (this) {
            if (finished) {
                return false;
            }
            if (!started) {
                held.add(text);
                return true;
            }
            s = sink;
        }
        return s != null && s.test(text);
    }

    /** 收尾了（之后补的话这个口子不收） */
    public synchronized boolean finished() {
        return finished;
    }

    /** 谁都没收走的：宿主起来过就是它交回的，没起来就是收着的那些 */
    public synchronized List<String> unconsumed() {
        return started ? List.copyOf(leftover) : List.copyOf(held);
    }
}
