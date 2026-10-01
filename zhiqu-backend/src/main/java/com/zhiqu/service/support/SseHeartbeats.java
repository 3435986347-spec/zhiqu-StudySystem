package com.zhiqu.service.support;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * SSE 心跳：流还开着、却一时没有事件可发的时候，每隔一段时间发一行 SSE 注释（{@code :ping}）。
 *
 * <p>为什么需要：推理模型在第一个字之前可能要想一两分钟，检索、code agent 这些前置阶段也可能长时间没有事件。
 * 这段时间连接上一个字节都没有 —— 反向代理（nginx 默认 60 秒）会把它当成死连接掐掉；
 * 客户端的「多久没数据就判断断线」也没法设得比最长的沉默更短，于是真断线要等很久才发现。
 * 有了心跳，两边都可以放心地设一个短的空闲超时。
 *
 * <p>注释行不是事件：规范的 SSE 解析器会丢掉它（网页的 parseSseFrame 与命令行的 SseParser 都判过）。
 * 网页聊天与命令行的模型网关共用这一份。
 */
@Component
public class SseHeartbeats {

    private final long periodMs;
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "sse-heartbeat");
        t.setDaemon(true);
        return t;
    });

    public SseHeartbeats(@Value("${app.sse.heartbeat-ms:15000}") long periodMs) {
        this.periodMs = Math.max(10, periodMs);
    }

    /** 开始给这个流发心跳。返回的句柄 {@code close()} 就停 —— 流结束（成功、出错、客户端断开）时都要调。 */
    public Beat start(SseEmitter emitter) {
        ScheduledFuture<?> future = scheduler.scheduleAtFixedRate(() -> {
            try {
                emitter.send(SseEmitter.event().comment("ping"));
            } catch (Exception ignored) {
                // 对方已经断开，或者流刚结束：发流的那个线程会自己发现
            }
        }, periodMs, periodMs, TimeUnit.MILLISECONDS);
        return () -> future.cancel(false);
    }

    @FunctionalInterface
    public interface Beat extends AutoCloseable {
        @Override
        void close();
    }
}
