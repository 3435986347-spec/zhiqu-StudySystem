package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 回答到一半走开、回来还能接上（第一百三十三轮）。
 *
 * <p>用户：「回答到一半我去查看索引了，回来就没了」「会回到上次回答完的状态」。
 *
 * <p>这一轮把「生成」和「看」拆开了：事件记在服务端的 {@code ChatRunHub} 里（那边的判据在
 * {@code ChatRunHubTest}），页面回来用 runId 重新挂上去。这里盯的是页面这一半：
 *
 * <ul>
 *   <li>发送时记下 runId；</li>
 *   <li>回到页面时真的会去接（不是只在注释里说会接）；</li>
 *   <li>接回来的事件和发送时走<b>同一份</b>落地逻辑 —— 两份迟早分叉，而分叉的表现
 *       就是「刷新之后和没刷新长得不一样」；</li>
 *   <li>「立即」不再是打断这一轮（用户：「不是要终止这一轮，是给模型补充信息」）。</li>
 * </ul>
 */
class AiReattachTest {

    private static final Path STATIC = Path.of("src/main/resources/static");
    private static final Path PAGE = STATIC.resolve("assets/pages/ai-assistant.js");

    private static String page() throws IOException {
        return SourceText.pageModule("ai-assistant.js");
    }

    @Test
    @DisplayName("发送和接回用的是同一份事件落地：两处都调 makeStreamApplier")
    void 一份事件落地() throws IOException {
        String js = page();
        String send = SourceText.functionBody(js, "async function sendAiMessage(queuedText)");
        assertTrue(send.contains("makeStreamApplier(st)"),
                "发送那条路没有用共享的事件落地 —— 接回来的那条迟早和它长得不一样");
        String reattach = SourceText.functionBody(js, "async function reattachRunningTurn()");
        assertTrue(reattach.contains("makeStreamApplier(st)"), "接回来那条路自己写了一套");
    }

    @Test
    @DisplayName("回到页面会去接还在跑的那一轮；接不上就交给轮询，不把这一轮标成失败")
    void 回来会接() throws IOException {
        String js = page();
        String load = SourceText.functionBody(js, "async function loadAiMessages()");
        assertTrue(load.contains("reattachRunningTurn("),
                "拉完消息没有去接还在跑的那一轮 —— 用户回来看到的还是「上次回答完的状态」");
        String reattach = SourceText.functionBody(js, "async function reattachRunningTurn()");
        assertTrue(reattach.contains("streamRunStream("), "没有真的去连 /ai/runs/{id}/stream");
        assertTrue(reattach.contains("reattachTried["), "没有「一次页面只试一次」的保护，会和轮询互相打架");
    }

    @Test
    @DisplayName("「立即」是补充信息，不是打断这一轮")
    void 立即不是打断() throws IOException {
        String js = page();
        String now = SourceText.functionBody(js, "function sendQueuedNow(i)");
        assertTrue(now.contains("/ai/runs/") && now.contains("/say"),
                "「立即」没有走补充信息的接口");
        assertFalse(now.contains(".abort("),
                "「立即」又在打断这一轮了 —— 用户看到的是半截回答当场消失");
        assertTrue(now.contains("delivered === 'current'"), "没有区分「补进去了」和「只能等下一轮」");
    }

    @Test
    @DisplayName("发布实现真跑：切会话保留后台消息、导航补齐进度再接直播、重连不清空、桌面存档幂等、队列不串会话")
    void 事件落地() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/stream-reattach-check.js"),
                        PAGE),
                "stream-reattach-check.js 没有全绿");
    }
}
