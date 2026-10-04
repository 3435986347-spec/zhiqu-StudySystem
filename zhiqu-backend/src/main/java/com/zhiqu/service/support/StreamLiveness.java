package com.zhiqu.service.support;

import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 进行中的回答和执行记录的心跳（第二十八轮）。一轮回答进行中，每 {@link #INTERVAL_SECONDS} 秒用<b>数据库的钟</b>
 * 碰一下这两行的 {@code heartbeat_at}；{@link InterruptedWorkRecovery} 只收心跳停了的。
 *
 * <p>原来收拾的条件是「这个进程启动之前建的」—— 好几个后端连同一个库时（用户的部署：桌面应用和网页端连同一个远程 MySQL），
 * 桌面应用一启动，服务器上正在生成的回答就被收成「服务在回答途中重启了」。心跳说的是「还有没有人在做它」，不管是哪个进程。
 * 用数据库的 {@code NOW()}：不同机器的钟对不齐，数据库只有一个。
 *
 * <p>心跳最多跳 {@code maxBeats} 次（默认 30 分钟）：一个卡死的线程会一直心跳，那条回答就永远收不掉。
 */
@Component
public class StreamLiveness {

    private static final Logger log = LoggerFactory.getLogger(StreamLiveness.class);
    public static final int INTERVAL_SECONDS = 30;

    private final JdbcTemplate jdbc;
    private final int maxBeats;
    private final ScheduledExecutorService ticker = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "stream-liveness");
        t.setDaemon(true);
        return t;
    });

    public StreamLiveness(JdbcTemplate jdbc, @Value("${app.ai.stream.max-heartbeat-minutes:30}") int maxMinutes) {
        this.jdbc = jdbc;
        this.maxBeats = Math.max(1, maxMinutes * 60 / INTERVAL_SECONDS);
    }

    /**
     * 开始给这一轮心跳：<b>当场</b>碰一次（在调用者的线程里 —— 放到定时线程上的话，一轮很快的回答可能在第一次心跳之前就结束了，
     * 而这一轮的头 30 秒恰恰是另一个实例启动时最容易误判的那段），之后每 30 秒一次；close() 停。任何一个 id 为空就只碰另一个。
     */
    public Lease hold(Long messageId, Long runId) {
        touch(messageId, runId);
        AtomicInteger beats = new AtomicInteger(1);
        Lease lease = new Lease();
        lease.future = ticker.scheduleWithFixedDelay(() -> {
            if (beats.incrementAndGet() > maxBeats) {
                lease.close();
                return;
            }
            touch(messageId, runId);
        }, INTERVAL_SECONDS, INTERVAL_SECONDS, TimeUnit.SECONDS);
        return lease;
    }

    void touch(Long messageId, Long runId) {
        try {
            if (messageId != null) {
                jdbc.update("UPDATE ai_message SET heartbeat_at = NOW() WHERE id = ? AND status = 'STREAMING'", messageId);
            }
            if (runId != null) {
                jdbc.update("UPDATE ai_agent_run SET heartbeat_at = NOW() WHERE id = ? AND status = 'RUNNING'", runId);
            }
        } catch (RuntimeException e) {
            // 碰不到就下一次再碰；连着几次都碰不到，那条回答会被当成没人在做 —— 那时库本身多半也出了问题
            log.warn("心跳没写进去：{}", e.getMessage());
        }
    }

    @PreDestroy
    void shutdown() {
        ticker.shutdownNow();
    }

    public static final class Lease implements AutoCloseable {
        private volatile ScheduledFuture<?> future;

        @Override
        public void close() {
            ScheduledFuture<?> f = future;
            if (f != null) {
                f.cancel(false);
            }
        }
    }
}
