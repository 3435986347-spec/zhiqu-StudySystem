package com.zhiqu.service.agent;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 读任务的门（第二十七轮）：不是纯聊天、开关开着、问到了安排 —— 三个条件缺一不可，每一个单独都能把它关上
 * （只测「都满足时开着」的话，三个条件随便删掉一个都还是绿的）。
 */
class TaskReaderGateTest {

    private static AgentPlanDecision decide(String mode, String message, boolean tasksReadable) {
        return AgentPlanDecision.of(mode, message, false, null, Map.of(), true, false, false, tasksReadable);
    }

    @Test
    @DisplayName("问到今天 / 这周 / 先做什么、开关开着、不是纯聊天 → 读")
    void 都满足时读() {
        for (String m : List.of("今天我先做什么？", "这周有什么要交的", "帮我排一下明天", "最近要忙的事", "哪些 DDL 快到了")) {
            assertTrue(decide("AUTO", m, true).needsTaskReader(), m);
        }
    }

    @Test
    @DisplayName("开关关着不读（不造节点）")
    void 开关关着不读() {
        assertFalse(decide("AUTO", "今天我先做什么？", false).needsTaskReader());
    }

    @Test
    @DisplayName("纯聊天不读")
    void 纯聊天不读() {
        assertFalse(decide("CHAT_ONLY", "今天我先做什么？", true).needsTaskReader());
    }

    @Test
    @DisplayName("没问安排不读：每一句都把任务标题发给模型是没必要的外泄")
    void 没问安排不读() {
        for (String m : List.of("你好", "解释一下什么是边际成本", "帮我润色这段邮件", "总结一下我上传的资料")) {
            assertFalse(decide("AUTO", m, true).needsTaskReader(), m);
        }
    }
}
