package com.zhiqu.service.support;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.service.ai.DecisionPort;
import org.junit.jupiter.api.Test;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyEmitter;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 一轮回答的直播 + 回放（第一百三十三轮）。
 *
 * <p>要钉住的是那三句承诺：<b>连接断了不影响记录</b>、<b>回来能按序接上</b>、
 * <b>「立即」是补充信息不是打断</b>。这三条任何一条破了，用户看到的就是「回答到一半没了」。
 */
class ChatRunHubTest {

    /** 记下发出去的东西，也可以随时「断掉」——模拟浏览器把页面关了。 */
    private static final class Recorder extends SseEmitter {
        private final List<String> names = new ArrayList<>();
        private final List<String> payloads = new ArrayList<>();
        private final List<String> sequence;
        private boolean broken;
        private boolean completed;

        private Recorder() {
            this(null);
        }

        private Recorder(List<String> sequence) {
            this.sequence = sequence;
        }

        @Override
        public void send(SseEventBuilder builder) throws IOException {
            if (broken) {
                throw new IOException("页面已经关了");
            }
            StringBuilder raw = new StringBuilder();
            for (ResponseBodyEmitter.DataWithMediaType part : builder.build()) {
                raw.append(part.getData());
            }
            String frame = raw.toString();
            String name = nameOf(frame);
            names.add(name);
            if (sequence != null) {
                sequence.add("sse:" + name);
            }
            payloads.add(dataOf(frame));
        }

        @Override
        public void complete() {
            completed = true;
        }

        private static String nameOf(String frame) {
            for (String line : frame.split("\n")) {
                if (line.startsWith("event:")) {
                    return line.substring("event:".length());
                }
            }
            return "";
        }

        private static String dataOf(String frame) {
            StringBuilder out = new StringBuilder();
            for (String line : frame.split("\n")) {
                if (line.startsWith("data:")) {
                    out.append(line.substring("data:".length()));
                }
            }
            return out.toString();
        }
    }

    private final ChatRunHub hub = new ChatRunHub(new ObjectMapper());

    @Test
    void 连接断了照样记_回来按序全部重放() {
        ChatRunHub.LiveRun run = hub.open(7L, text -> true);
        Recorder first = new Recorder();
        assertEquals(ChatRunHub.Attach.LIVE, hub.attach(7L, first, 0));

        run.emit("message.delta", Map.of("text", "第一段"));
        assertEquals(List.of("message.delta"), first.names);

        // 用户切去看管理后台，浏览器把连接关了
        first.broken = true;
        run.emit("message.delta", Map.of("text", "第二段"));   // 不能抛：生成要接着跑
        run.emit("message.delta", Map.of("text", "第三段"));

        // 回来接上：三帧都在，顺序不变
        Recorder second = new Recorder();
        assertEquals(ChatRunHub.Attach.LIVE, hub.attach(7L, second, 0));
        assertEquals(List.of("message.delta", "message.delta", "message.delta"), second.names);
        assertTrue(second.payloads.get(1).contains("第二段"), second.payloads.toString());
        assertTrue(second.payloads.get(2).contains("第三段"), second.payloads.toString());

        // 接上之后继续直播
        run.emit("message.delta", Map.of("text", "第四段"));
        assertTrue(second.payloads.get(3).contains("第四段"));
    }

    @Test
    void after_只补没收到的那几帧_不重复() {
        ChatRunHub.LiveRun run = hub.open(8L, text -> true);
        run.emit("message.delta", Map.of("text", "一"));
        run.emit("message.delta", Map.of("text", "二"));
        run.emit("message.delta", Map.of("text", "三"));
        Recorder rec = new Recorder();
        hub.attach(8L, rec, 2);
        assertEquals(1, rec.names.size(), "after=2 只该补第 3 帧：" + rec.payloads);
        assertTrue(rec.payloads.get(0).contains("三"));
    }

    @Test
    void 跑完了再回来_重放里带着_done_然后收掉() {
        ChatRunHub.LiveRun run = hub.open(9L, text -> true);
        run.emit("stream.start", Map.of("agentRunId", 9));
        run.emit("message.delta", Map.of("text", "答完了"));
        run.emit("done", Map.of("status", "DONE"));
        run.finish();

        Recorder rec = new Recorder();
        assertEquals(ChatRunHub.Attach.FINISHED, hub.attach(9L, rec, 0));
        assertEquals(List.of("stream.start", "message.delta", "done"), rec.names);
        assertTrue(rec.completed, "重放完要收掉连接，不能让页面一直挂着");
    }

    @Test
    void 跑完了但收尾事件没进来_让页面回去读库() {
        ChatRunHub.LiveRun run = hub.open(10L, text -> true);
        run.emit("stream.start", Map.of("agentRunId", 10));
        run.finish();   // 装配期就失败那种：没有 done / error

        Recorder rec = new Recorder();
        assertEquals(ChatRunHub.Attach.FINISHED, hub.attach(10L, rec, 0));
        assertEquals(List.of("stream.start", "stream.gone"), rec.names, "没有终态事件时要说「别等了」");
    }

    @Test
    void 不认识的_run_说_GONE_页面回去读消息列表() {
        assertEquals(ChatRunHub.Attach.GONE, hub.attach(404L, new Recorder(), 0));
    }

    @Test
    void 缓冲丢过帧_重连先发_reset_让页面按库里的正文铺一遍() {
        ChatRunHub.LiveRun run = hub.open(11L, text -> true);
        // 4000 帧是上限，多发的会从头丢
        for (int i = 0; i < 4005; i++) {
            run.emit("message.delta", Map.of("text", "x" + i));
        }
        Recorder rec = new Recorder();
        hub.attach(11L, rec, 0);
        assertEquals("stream.reset", rec.names.get(0), "丢过帧要先说一声，否则接出来的正文缺一截还没人知道");
    }

    @Test
    void 立即是补充信息_不是打断() {
        boolean[] accepted = {true};
        ChatRunHub.LiveRun run = hub.open(12L, text -> accepted[0]);
        Recorder rec = new Recorder();
        hub.attach(12L, rec, 0);

        assertEquals("current", hub.say(12L, "顺便说一下，我用的是 Java 17"));
        assertTrue(rec.names.contains("message.injected"), "补进去的话要让页面看得见，不能凭空消失");

        accepted[0] = false;   // 已经在写最终回答
        assertEquals("next", hub.say(12L, "再补一句"));
    }

    @Test
    void 补充等回音时不攥着这一轮的锁_另一个线程照样能发事件() throws Exception {
        // 代码模式（第一百五十二轮）：inject 要等宿主回音，而回音由读宿主输出的线程交来 —— 那个线程同时还要 emit 事件。
        // 原来 inject 是 synchronized、emit 也是：攥着锁等就是两边互等到超时
        java.util.concurrent.CountDownLatch emitted = new java.util.concurrent.CountDownLatch(1);
        ChatRunHub.LiveRun[] holder = new ChatRunHub.LiveRun[1];
        holder[0] = hub.open(15L, text -> {
            Thread reader = new Thread(() -> {
                holder[0].emit("trace.step", Map.of("id", "s1"));
                emitted.countDown();
            });
            reader.start();
            try {
                return emitted.await(2, java.util.concurrent.TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                return false;
            }
        });
        long t0 = System.nanoTime();
        assertEquals("current", hub.say(15L, "补一句"));
        assertTrue((System.nanoTime() - t0) / 1_000_000 < 1500, "等到超时才回：inject 攥着锁，发事件的线程进不来");
    }

    @Test
    void 跑完之后的补充只能算下一轮() {
        ChatRunHub.LiveRun run = hub.open(13L, text -> true);
        run.finish();
        assertEquals("next", hub.say(13L, "还在吗"));
        assertFalse(hub.say(404L, "没有这一轮") == null);
    }

    @Test
    void 决策先回放解决事件再唤醒宿主_相同答案不重复发帧() {
        DecisionPort decisions = new DecisionPort();
        ChatRunHub.LiveRun run = hub.open(16L, text -> true);
        run.useDecisions(decisions);
        List<String> sequence = new ArrayList<>();
        List<Map<String, Object>> delivered = new ArrayList<>();
        Map<String, Object> question = new java.util.LinkedHashMap<>();
        question.put("id", "q1");
        question.put("header", "实现");
        question.put("question", "怎么做？");
        question.put("allowOther", false);
        question.put("options", List.of(
                Map.of("id", "o1", "label", "甲", "recommended", true),
                Map.of("id", "o2", "label", "乙", "recommended", false)));
        List<Map<String, Object>> questions = decisions.offer("d1", List.of(question), message -> {
            delivered.add(message);
            sequence.add("host");
        });
        run.emit("decision.ask", Map.of("decisionId", "d1", "questions", questions));
        Recorder rec = new Recorder(sequence);
        hub.attach(16L, rec, 0);

        Map<String, Object> accepted = run.answerDecision("d1", Map.of("cancelled", false, "answers",
                List.of(Map.of("questionId", "q1", "optionId", "o2"))));
        assertEquals(true, accepted.get("accepted"));
        assertEquals(List.of("decision.ask", "decision.resolved"), rec.names, "解决事件必须先于宿主继续");
        assertEquals(List.of("sse:decision.ask", "sse:decision.resolved", "host"), sequence, "宿主在解决事件落回放之前就被唤醒了");
        assertEquals(1, delivered.size());
        assertEquals("question_result", delivered.get(0).get("type"));
        Map<String, Object> duplicate = run.answerDecision("d1", Map.of("cancelled", false, "answers",
                List.of(Map.of("questionId", "q1", "optionId", "o2"))));
        assertEquals(true, duplicate.get("duplicate"));
        assertEquals(2, rec.names.size());
        assertEquals(1, delivered.size());
        hub.finish(16L);
    }

    @Test
    void 运行结束会取消仍待回答的问题() {
        DecisionPort decisions = new DecisionPort();
        ChatRunHub.LiveRun run = hub.open(17L, text -> true);
        run.useDecisions(decisions);
        List<Map<String, Object>> delivered = new ArrayList<>();
        Map<String, Object> question = new java.util.LinkedHashMap<>();
        question.put("id", "q1");
        question.put("header", "");
        question.put("question", "怎么做？");
        question.put("allowOther", false);
        question.put("options", List.of(
                Map.of("id", "o1", "label", "甲", "recommended", true),
                Map.of("id", "o2", "label", "乙", "recommended", false)));
        decisions.offer("d2", List.of(question), delivered::add);
        hub.finish(17L);
        assertEquals(1, delivered.size());
        assertEquals(true, delivered.get(0).get("cancelled"));
        assertEquals(false, run.answerDecision("d2", Map.of("cancelled", true, "answers", List.of())).get("accepted"));
    }

    @Test
    void 收尾是幂等的_正常和异常两条路都走它() {
        ChatRunHub.LiveRun run = hub.open(14L, text -> true);
        run.finish();
        run.finish();
        hub.finish(14L);
        assertEquals(1, hub.liveCount());
    }
}
