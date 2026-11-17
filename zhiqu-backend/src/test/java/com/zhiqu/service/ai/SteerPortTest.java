package com.zhiqu.service.ai;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 补充递给宿主的口子（第一百五十二轮）：起来之前收着、起来那一刻随 run 交出去、之后走 say、收尾之后不收，一个字不丢。 */
class SteerPortTest {

    @Test
    @DisplayName("宿主起来之前补的话收着；起来那一刻和开的时候带的一起随 run 交出去；之后走 sink")
    void 三段() {
        SteerPort port = new SteerPort(List.of("检索那会儿补的"));
        assertTrue(port.say("起 node 那会儿补的"));
        List<String> inRun = new ArrayList<>();
        List<String> said = new ArrayList<>();
        port.start(inRun::addAll, t -> said.add(t));
        assertEquals(List.of("检索那会儿补的", "起 node 那会儿补的"), inRun);
        assertTrue(port.say("跑着的时候补的"));
        assertEquals(List.of("跑着的时候补的"), said);
        port.finish(List.of("宿主没读到的"));
        assertFalse(port.say("收尾之后的"), "收尾之后不收：页面把它排到下一轮");
        assertEquals(List.of("宿主没读到的"), port.unconsumed());
    }

    @Test
    @DisplayName("宿主没起来（没有代码意图、找不到 node）：收着的原样交回，不丢")
    void 没起来() {
        SteerPort port = new SteerPort(List.of("a"));
        port.say("b");
        port.finish(List.of());
        assertEquals(List.of("a", "b"), port.unconsumed());
        // 收尾之后（调用方已经把剩下的取走了）再补的：必须不收，不然收进一个没人再取的列表里，话就丢了
        assertFalse(port.say("c"));
        assertEquals(List.of("a", "b"), port.unconsumed());
    }

    @Test
    @DisplayName("发 run 的那一刻到的 say：等 run 发完再走 sink —— 不会既不在 run 里、也没说给宿主")
    void 发run那一刻() throws Exception {
        SteerPort port = new SteerPort(List.of());
        CountDownLatch sending = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        List<String> inRun = new ArrayList<>();
        List<String> said = new ArrayList<>();
        Thread starter = new Thread(() -> port.start(initial -> {
            sending.countDown();
            try {
                release.await(2, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            inRun.addAll(initial);
        }, t -> { said.add(t); return true; }));
        starter.start();
        assertTrue(sending.await(2, TimeUnit.SECONDS));
        AtomicBoolean ok = new AtomicBoolean();
        Thread sayer = new Thread(() -> ok.set(port.say("正好这时候")));
        sayer.start();
        Thread.sleep(100);
        release.countDown();
        starter.join(2000);
        sayer.join(2000);
        assertTrue(ok.get());
        assertEquals(List.of(), inRun);
        assertEquals(List.of("正好这时候"), said);
    }
}
