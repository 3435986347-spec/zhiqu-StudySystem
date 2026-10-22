package com.zhiqu.service.support;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 心跳停下之后不会再有一行 ping 落在结束事件后面（第四十七轮）。由来：{@code HarnessHeartbeatTest}「done 之后不该还有心跳」在全量里偶尔红 ——
 * 原来 close 只是 {@code future.cancel(false)}，已经开始跑、正在发的那一趟取消不掉，它落在 done 后面。
 * 这里把那一趟卡在「正在发」，在它发完之前 close、发 done，看最后一行是不是 done（不靠时序碰运气）。
 */
class SseHeartbeatsTest {

    @Test
    @DisplayName("一趟 ping 正在发的时候 close：close 等它发完；之后发的结束事件是最后一行")
    void 停了就不会落在后面() throws Exception {
        List<String> sent = new CopyOnWriteArrayList<>();
        CountDownLatch pingStarted = new CountDownLatch(1);
        SseEmitter emitter = new SseEmitter(0L) {
            @Override
            public void send(SseEventBuilder builder) throws IOException {
                String text = builder.build().stream().map(d -> String.valueOf(d.getData())).collect(Collectors.joining());
                boolean ping = text.contains("ping");
                if (ping) {
                    pingStarted.countDown();
                    try {
                        Thread.sleep(150);   // 卡在「正在发」
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                }
                sent.add(ping ? "ping" : "event");
            }
        };
        SseHeartbeats heartbeats = new SseHeartbeats(10);
        SseHeartbeats.Beat beat = heartbeats.start(emitter);
        assertTrue(pingStarted.await(2, TimeUnit.SECONDS), "心跳没开始");
        beat.close();
        emitter.send(SseEmitter.event().name("done").data("x"));
        Thread.sleep(250);   // 原来的写法里，那一趟 ping 会在这段时间里落到 done 后面
        assertEquals("event", sent.get(sent.size() - 1), "结束事件之后又发了心跳：" + sent);
    }
}
