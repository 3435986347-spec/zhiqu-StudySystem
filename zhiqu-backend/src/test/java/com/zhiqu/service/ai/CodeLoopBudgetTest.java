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
    @DisplayName("显式档：不再限轮、不再限时（0 = 不限），但单次模型调用仍有上限")
    void 显式档不再限时() {
        CodeLoopBudget b = CodeLoopBudget.EXPLICIT;
        assertTrue(b.rounds() == 0, "显式档的轮数应当 0（不限），现在是 " + b.rounds() + "：做到一半停下，下一次又从零开始");
        assertTrue(b.millis() == 0, "显式档的时长应当 0（不限），现在是 " + b.millis() + "ms");
        assertTrue(b.unlimited(), "0 / 0 要认成不限");
        // 不限总时长不等于单次调用可以无限等：一轮想 150 秒是正常的，卡住不能一直挂着
        assertTrue(b.turnLimits(0).readTimeoutMillis() == b.callTimeoutCapMillis(), "不限时的单次调用要按单次上限走");
        assertTrue(b.turnLimits(Long.MAX_VALUE / 4).readTimeoutMillis() == b.callTimeoutCapMillis(), "过了很久也还是单次上限");
        assertTrue(b.callTimeoutCapMillis() > 0 && b.callTimeoutCapMillis() <= 300_000, "单次调用要有上限（防卡死）");
    }

    @Test
    @DisplayName("关键词档仍然又小又短：过触发要便宜")
    void 关键词档要小() {
        CodeLoopBudget k = CodeLoopBudget.KEYWORD;
        assertTrue(k.rounds() > 0 && k.rounds() <= 10, "关键词档轮数要小");
        assertTrue(k.millis() > 0 && k.millis() <= 60_000, "关键词档时长要短");
        assertTrue(k.maxTokensPerCall() < CodeLoopBudget.EXPLICIT.maxTokensPerCall(), "关键词档不能给大输出");
    }

    @Test
    @DisplayName("整条流的上限仍然存在，且比单次调用长")
    void 流的上限还在() {
        long stream = AiWorkspaceService.STREAM_TIMEOUT_MS;
        assertTrue(stream >= 3_600_000, "不限时的代码任务要留够连接时间，现在只有 " + stream + "ms");
        assertTrue(CodeLoopBudget.EXPLICIT.callTimeoutCapMillis() < stream, "单次调用不能比整条流还长");
    }
}
