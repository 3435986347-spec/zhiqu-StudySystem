package com.zhiqu.service.agent;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * 「这句话要 AI 把计划建成任务草稿吗」（{@link AgentPlanDecision#taskCreationIntent}）拿真实说法探一遍。
 *
 * <p>2026-10-03 新用户走主流程：「根据这份总结，帮我制定下周的工作计划」—— 最自然的说法 —— 不出计划，因为动词表里没有「制定」
 * （CLAUDE.md 却一直写着它在）；执行轨迹还照样写「计划草稿已整理」。
 *
 * <p>门是故意窄的：过触发的代价是弹一个用户没要的确认框（确认框本身就诱导人去点），所以只说「计划」不带建的动作时不出草稿。
 * 下面「不该出」那一组钉的就是这个取舍；「安排一下」这类只有计划词的说法要不要也出草稿，见 docs/product-plan.md「要你定」。
 */
class PlanCreationIntentTest {

    private static final List<String> SHOULD = List.of(
            "根据这份总结，帮我制定下周的工作计划",
            "帮我制定下周的工作计划",
            "制定一个项目上线前两周的计划",
            "把下周的工作计划生成任务",
            "帮我生成一个复习计划",
            "把这些安排添加到我的任务里",
            "给我创建一个每天写周报的例行任务");

    private static final List<String> SHOULD_NOT = List.of(
            "我下周的计划是什么",
            "帮我看看这个计划合不合理",
            "今天的任务有哪些",
            "公司正在制定新的考勤制度",
            "蓝鲸计划是哪天上线的",
            "这份总结写得怎么样");

    @Test
    @DisplayName("要建任务的说法都出计划（含「制定」）；只是提到计划 / 任务的不出")
    void 真实说法() {
        List<String> wrong = new ArrayList<>();
        for (String s : SHOULD) if (!AgentPlanDecision.taskCreationIntent(s)) wrong.add("该出没出：" + s);
        for (String s : SHOULD_NOT) if (AgentPlanDecision.taskCreationIntent(s)) wrong.add("不该出却出了：" + s);
        assertEquals(List.of(), wrong);
    }
}
