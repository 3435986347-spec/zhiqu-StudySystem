package com.zhiqu.service.ai;

import com.zhiqu.service.AiWorkspaceService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 代码模式的时间预算（CodeLoopBudget 的注释说这里钉着 —— 第一百二十八轮之前其实没有这个类）。
 *
 * <p>第一百二十八轮：线上一次「做一个游戏」第一下想了 100 秒，180 秒用完时只写完了核心和测试。预算加到 240 秒，
 * 但整条流 300 秒，循环停下之后还要收尾（代码模式的回答就是循环自己的结论，存库、发 done）—— 两者之间至少留 30 秒；
 * 单次模型调用的读超时也不能把循环拖过整条流。
 */
class CodeLoopBudgetTest {

    @Test
    @DisplayName("显式档：循环 + 收尾在整条流的超时之内；单次调用最多等到预算用完、不越过整条流")
    void 预算在整条流之内() {
        CodeLoopBudget b = CodeLoopBudget.EXPLICIT;
        long stream = AiWorkspaceService.STREAM_TIMEOUT_MS;
        assertTrue(b.millis() + 30_000 <= stream, "循环 " + b.millis() + "ms + 收尾 30 秒 超过整条流 " + stream + "ms：回答出不来");
        assertTrue(b.millis() >= 600_000, "显式代码任务至少留 10 分钟，不能仍在 4 分钟被截断");
        assertTrue(b.rounds() >= 80, "显式代码任务至少留 80 轮，不能仍在 40 轮被截断");
        assertTrue(stream >= 900_000, "整条回答至少留 15 分钟，不能先于代码任务和收尾断开");
        // 最后一刻开始的一次调用：读超时取剩余（至少 5 秒），不能再给它 150 秒
        long last = b.turnLimits(b.millis() - 1_000).readTimeoutMillis();
        assertTrue(b.millis() - 1_000 + last <= stream, "最后一刻开始的调用能等到 " + (b.millis() - 1_000 + last) + "ms，越过整条流");
        assertTrue(CodeLoopBudget.KEYWORD.millis() < b.millis() && CodeLoopBudget.KEYWORD.rounds() < b.rounds(), "关键词档要比显式档小（过触发要便宜）");
    }
}
