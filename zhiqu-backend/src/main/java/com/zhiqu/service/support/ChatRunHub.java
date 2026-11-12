package com.zhiqu.service.support;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * 一轮回答的「直播 + 回放」（第一百三十三轮）。
 *
 * <h2>为什么需要它</h2>
 *
 * <p>用户：「回答到一半我去查看索引了，回来就没了」。一轮回答原来只往<b>那一条</b> {@link SseEmitter} 上写事件：
 * 页面一导航，浏览器把连接关了，之后所有事件都写进了一个没人读的管子。而「这一轮在跑」这件事
 * 在服务端没有任何可以再连上来的入口 —— 页面回来只能重新拉消息列表，看到的是库里那一份，
 * 还在生成的后半截再也接不回来。
 *
 * <p>现在每个 run 有一个 {@link LiveRun}：事件先按顺序记在内存里（有上限），再顺手推给当前挂着的那条连接。
 * 连接断了不影响记录，也不影响生成；页面回来 {@code GET /api/ai/runs/{id}/stream?after=N}
 * 把记下来的按序重放，然后接着直播。<b>SSE 从此只是一个读取器。</b>
 *
 * <h2>为什么不是「把生成搬到别处」</h2>
 *
 * <p>生成本来就在 {@code CompletableFuture} 里、不依赖请求线程。真正让它断掉的是「事件没处可写」和
 * 「没有重连入口」。把这两件事补上，比另造一套任务队列小得多，也不会动到回答链路的其它部分。
 *
 * <h2>内存</h2>
 *
 * <p>每个 run 最多留 {@link #MAX_FRAMES} 帧 / {@link #MAX_BYTES} 字节，超了从头丢（回答很长时，
 * 前面的增量已经没人会看了）。跑完再留 {@link #KEEP_FINISHED_MS}，够页面从后台切回来重连一次。
 * 丢过帧的 run 在重连时先发一条 {@code stream.reset}，页面据此先把库里的正文铺一遍，避免接出重复内容。
 */
@Component
public class ChatRunHub {

    private static final Logger log = LoggerFactory.getLogger(ChatRunHub.class);

    /** 一輪最多留多少帧。一次回答的增量通常几百帧，四千足够覆盖最长的那些。 */
    private static final int MAX_FRAMES = 4000;
    /** 一輪最多留多少字节（序列化之后的）。20 万字的回答约 600KB，2MB 是它的三倍多。 */
    private static final long MAX_BYTES = 2L * 1024 * 1024;
    /** 跑完之后还留多久。 */
    private static final long KEEP_FINISHED_MS = TimeUnit.MINUTES.toMillis(5);
    /** 内存里同时留多少个 run；超了先把已经跑完的清掉。 */
    private static final int MAX_RUNS = 500;

    private final ObjectMapper objectMapper;
    private final Map<Long, LiveRun> runs = new ConcurrentHashMap<>();
    private final ScheduledExecutorService reaper = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "chat-run-reaper");
        t.setDaemon(true);
        return t;
    });

    public ChatRunHub(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    /** 一轮回答往自己上下文里补话的入口（「立即」不再是打断，而是补充信息）。 */
    public interface Turn {
        /**
         * @return true = 模型下一次调用就能看到；false = 这一轮已经在写最终回答了，只能等它结束
         */
        boolean inject(String text);
    }

    /** 重连的结果。页面据此决定是接着直播，还是回去读消息列表。 */
    public enum Attach {
        /** 还活着，已经接上，后面的事件会继续推。 */
        LIVE,
        /** 已经跑完了：重放里带着 done / error，调用方可以直接收尾。 */
        FINISHED,
        /** 没有这一轮了（服务重启过、或者超过保留时间），去读消息列表。 */
        GONE
    }

    private record Frame(long seq, String name, String json) {
    }

    /**
     * 一个还在内存里的 run。
     *
     * <p>所有方法都在 {@code this} 上同步：事件来自生成线程，重放来自 HTTP 线程，
     * 两边必须看到同一个顺序，否则重连时会漏帧或者重复。
     */
    public final class LiveRun {

        private final Long runId;
        private final Deque<Frame> frames = new ArrayDeque<>();
        private long nextSeq = 1;
        private long bytes;
        /** 已经丢掉的最大的 seq。重连时 after 小于它，说明要的那段没了。 */
        private long droppedThrough;
        private SseEmitter attached;
        private boolean finished;
        private long finishedAt;
        private Turn turn;

        private LiveRun(Long runId, Turn turn) {
            this.runId = runId;
            this.turn = turn;
        }

        public Long runId() {
            return runId;
        }

        /** 记一帧，顺手推给挂着的那条连接。任何异常都不往外抛 —— 生成不能因为没人看就停下。 */
        public synchronized void emit(String name, Object data) {
            if (finished) {
                // 收尾之后还有事件：正常不会发生（done 之后就没有了）。记下来会污染重放，直接丢
                return;
            }
            String json;
            try {
                json = objectMapper.writeValueAsString(data);
            } catch (Exception e) {
                log.warn("事件序列化失败，跳过这一帧：runId={} name={} {}", runId, name, e.toString());
                return;
            }
            Frame frame = new Frame(nextSeq++, name, json);
            frames.addLast(frame);
            bytes += json.length();
            while (!frames.isEmpty() && (frames.size() > MAX_FRAMES || bytes > MAX_BYTES)) {
                Frame gone = frames.removeFirst();
                bytes -= gone.json().length();
                droppedThrough = gone.seq();
            }
            if (attached != null && !send(attached, frame)) {
                attached = null;
            }
        }

        /**
         * 把 {@code after} 之后的事件重放一遍，然后挂上去。
         *
         * <p>重放和挂载在同一把锁里：中间插进来的事件要么在重放里、要么走直播，不会两头都漏。
         */
        public synchronized Attach attach(SseEmitter emitter, long after) {
            if (finished) {
                return replayThenClose(emitter, after);
            }
            if (after < droppedThrough) {
                // 要的那一段已经被丢了：先告诉页面「重置」，它会把库里的正文铺一遍再往下接
                sendRaw(emitter, "stream.reset", "{\"reason\":\"buffer-dropped\",\"after\":" + droppedThrough + "}");
                after = droppedThrough;
            }
            List<Frame> replay = new ArrayList<>();
            for (Frame frame : frames) {
                if (frame.seq() > after) {
                    replay.add(frame);
                }
            }
            for (Frame frame : replay) {
                if (!send(emitter, frame)) {
                    return Attach.GONE;
                }
            }
            if (attached != null && attached != emitter) {
                // 同一轮在另一个标签页里也开着：新的接管，旧的收掉（两边都直播会各写一半）
                try {
                    attached.complete();
                } catch (Exception ignored) {
                    // 旧连接早就断了
                }
            }
            attached = emitter;
            emitter.onCompletion(() -> detach(emitter));
            emitter.onTimeout(() -> detach(emitter));
            emitter.onError(e -> detach(emitter));
            return Attach.LIVE;
        }

        private Attach replayThenClose(SseEmitter emitter, long after) {
            List<Frame> replay = new ArrayList<>();
            for (Frame frame : frames) {
                if (frame.seq() > after) {
                    replay.add(frame);
                }
            }
            for (Frame frame : replay) {
                if (!send(emitter, frame)) {
                    return Attach.GONE;
                }
            }
            boolean terminal = !replay.isEmpty() && isTerminal(replay.get(replay.size() - 1).name());
            if (!terminal) {
                // 这一轮结束了、但收尾那条事件没进到这里（装配期就失败了那种）：让页面去读库，别在这儿等
                sendRaw(emitter, "stream.gone", "{\"reason\":\"finished-without-terminal\"}");
            }
            try {
                emitter.complete();
            } catch (Exception ignored) {
                // 已经关了
            }
            return Attach.FINISHED;
        }

        /** 「立即」：把这句话补进这一轮的上下文。返回 true 表示模型下一次调用就能看到。 */
        public synchronized boolean inject(String text) {
            if (finished || turn == null) {
                return false;
            }
            return turn.inject(text);
        }

        /** 这一轮结束了：收掉连接，留着缓冲等页面回来重放，过一会儿再清。 */
        public synchronized void finish() {
            if (finished) {
                return;
            }
            finished = true;
            finishedAt = System.currentTimeMillis();
            turn = null;
            if (attached != null) {
                try {
                    attached.complete();
                } catch (Exception ignored) {
                    // 已经断了
                }
                attached = null;
            }
        }

        private synchronized void detach(SseEmitter emitter) {
            if (attached == emitter) {
                attached = null;
            }
        }

        private synchronized void abort() {
            finished = true;
            finishedAt = System.currentTimeMillis();
            turn = null;
            if (attached != null) {
                try {
                    attached.complete();
                } catch (Exception ignored) {
                    // 已经断了
                }
                attached = null;
            }
        }

        private boolean send(SseEmitter emitter, Frame frame) {
            try {
                emitter.send(SseEmitter.event().name(frame.name()).data(frame.json(), MediaType.APPLICATION_JSON));
                return true;
            } catch (Exception e) {
                // 浏览器关掉了这一页：记下来，等它回来重放。不是错误，不打日志
                return false;
            }
        }

        private void sendRaw(SseEmitter emitter, String name, String json) {
            try {
                emitter.send(SseEmitter.event().name(name).data(json, MediaType.APPLICATION_JSON));
            } catch (Exception ignored) {
                // 同上
            }
        }
    }

    /** 开一轮。同一个 runId 不会开两次；真撞上了（不该发生）把旧的收掉。 */
    public LiveRun open(Long runId, Turn turn) {
        LiveRun run = new LiveRun(runId, turn);
        LiveRun old = runs.put(runId, run);
        if (old != null) {
            old.abort();
        }
        evictIfCrowded();
        return run;
    }

    public LiveRun find(Long runId) {
        return runId == null ? null : runs.get(runId);
    }

    /** 收尾。幂等：正常收尾、异常收尾、装配失败都会走到这里。 */
    public void finish(Long runId) {
        LiveRun run = find(runId);
        if (run == null) {
            return;
        }
        run.finish();
        reaper.schedule(() -> runs.remove(runId, run), KEEP_FINISHED_MS, TimeUnit.MILLISECONDS);
    }

    /**
     * 重连。返回 GONE 表示这一轮不在内存里了（服务重启过 / 早就结束并清理了），
     * 调用方应当让页面回去读消息列表。
     */
    public Attach attach(Long runId, SseEmitter emitter, long after) {
        LiveRun run = find(runId);
        if (run == null) {
            return Attach.GONE;
        }
        return run.attach(emitter, after);
    }

    /**
     * 「立即」：把这句话补进这一轮。
     *
     * @return {@code current} = 已经交给这一轮（模型下一次调用能看到）；{@code next} = 这一轮接不了了，
     *         页面应当把它留在队列里，等这一轮结束再发
     */
    public String say(Long runId, String text) {
        LiveRun run = find(runId);
        if (run == null) {
            return "next";
        }
        if (!run.inject(text)) {
            return "next";
        }
        // 让页面和别的标签页都看到「这句是补进这一轮的」，而不是凭空消失
        run.emit("message.injected", Map.of("text", text));
        return "current";
    }

    /** 内存里同时留太多 run 时，先把已经跑完的清掉。 */
    private void evictIfCrowded() {
        if (runs.size() <= MAX_RUNS) {
            return;
        }
        long now = System.currentTimeMillis();
        for (Map.Entry<Long, LiveRun> entry : runs.entrySet()) {
            LiveRun run = entry.getValue();
            synchronized (run) {
                if (run.finished && now - run.finishedAt > 0) {
                    runs.remove(entry.getKey(), run);
                }
            }
        }
    }

    private static boolean isTerminal(String name) {
        return "done".equals(name) || "error".equals(name);
    }

    /** 测试与运维用：现在内存里有几轮。 */
    public int liveCount() {
        return runs.size();
    }
}
