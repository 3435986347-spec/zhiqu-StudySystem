package com.zhiqu.service.ai;

import com.zhiqu.common.BusinessException;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DecisionPortTest {

    static List<Map<String, Object>> questions() {
        Map<String, Object> q1 = new LinkedHashMap<>();
        q1.put("id", "q1");
        q1.put("header", "实现");
        q1.put("question", "采用哪种实现？");
        q1.put("allowOther", false);
        q1.put("options", List.of(
                Map.of("id", "o1", "label", "方案甲", "description", "推荐方案", "recommended", true),
                Map.of("id", "o2", "label", "方案乙", "description", "备选", "recommended", false)));
        Map<String, Object> q2 = new LinkedHashMap<>();
        q2.put("id", "q2");
        q2.put("header", "验证");
        q2.put("question", "怎样验证？");
        q2.put("allowOther", true);
        q2.put("options", List.of(
                Map.of("id", "o1", "label", "自动验证", "description", "", "recommended", true),
                Map.of("id", "o2", "label", "手工验证", "description", "", "recommended", false)));
        return List.of(q1, q2);
    }

    private static Map<String, Object> body(Object answers) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("cancelled", false);
        body.put("answers", answers);
        return body;
    }

    private static List<Map<String, Object>> validAnswers() {
        return List.of(
                Map.of("questionId", "q1", "optionId", "o2"),
                Map.of("questionId", "q2", "optionId", DecisionPort.OTHER_OPTION, "otherText", "  在真浏览器里验证  "));
    }

    @Test
    @SuppressWarnings("unchecked")
    void 完整答案_相同重复不重复唤醒_冲突第一次有效() {
        DecisionPort port = new DecisionPort();
        List<Map<String, Object>> delivered = new ArrayList<>();
        List<Map<String, Object>> questions = port.offer("d1", questions(), delivered::add);
        assertEquals(2, questions.size());
        assertEquals("方案甲", ((List<Map<String, Object>>) questions.get(0).get("options")).get(0).get("label"));
        DecisionPort.Result first = port.answer("d1", body(validAnswers()));
        assertTrue(first.resolved());
        assertEquals(true, first.payload().get("accepted"));
        assertEquals("在真浏览器里验证", first.payload().get("answers") instanceof List<?> list
                && list.get(1) instanceof Map<?, ?> answer ? answer.get("otherText") : null);
        first.deliver();
        assertEquals(1, delivered.size());
        assertEquals("question_result", delivered.get(0).get("type"));
        assertEquals("d1", delivered.get(0).get("id"));

        DecisionPort.Result duplicate = port.answer("d1", body(validAnswers()));
        assertTrue(duplicate.payload().get("accepted") instanceof Boolean accepted && accepted);
        assertTrue(duplicate.payload().get("duplicate") instanceof Boolean repeated && repeated);
        DecisionPort.Result conflict = port.answer("d1", body(List.of(
                Map.of("questionId", "q1", "optionId", "o1"),
                Map.of("questionId", "q2", "optionId", "o1"))));
        assertFalse((Boolean) conflict.payload().get("accepted"));
        assertTrue((Boolean) conflict.payload().get("duplicate"));
        assertEquals(1, delivered.size(), "重复和冲突都不能再次唤醒宿主");
    }

    @Test
    void 非法答案不占用批次_修正后仍能提交() {
        DecisionPort port = new DecisionPort();
        port.offer("d1", questions(), ignored -> { });
        assertThrows(BusinessException.class, () -> port.answer("d1", body(List.of())));
        assertThrows(BusinessException.class, () -> port.answer("d1", body(List.of(
                Map.of("questionId", "q1", "optionId", DecisionPort.OTHER_OPTION, "otherText", "不允许"),
                Map.of("questionId", "q2", "optionId", "o1")))));
        assertThrows(BusinessException.class, () -> port.answer("d1", body(List.of(
                Map.of("questionId", "q1", "optionId", "o2"),
                Map.of("questionId", "q2", "optionId", DecisionPort.OTHER_OPTION, "otherText", " ")))));
        assertTrue(port.answer("d1", body(validAnswers())).resolved());
    }

    @Test
    void 上一批没答不能开下一批_关闭时取消等待且迟到答案无效() {
        DecisionPort port = new DecisionPort();
        List<Map<String, Object>> delivered = new ArrayList<>();
        port.offer("d1", questions(), delivered::add);
        assertThrows(BusinessException.class, () -> port.offer("d2", questions(), ignored -> { }));
        port.close();
        assertEquals(1, delivered.size());
        assertEquals(true, delivered.get(0).get("cancelled"));
        assertFalse((Boolean) port.answer("d1", body(validAnswers())).payload().get("accepted"));
    }

    @Test
    void 问题本身也要核_不能注册半截问题() {
        DecisionPort port = new DecisionPort();
        List<Map<String, Object>> invalid = new ArrayList<>(questions());
        Map<String, Object> first = new LinkedHashMap<>(invalid.get(0));
        first.put("options", List.of(Map.of("id", "o1", "label", "只有一个")));
        invalid.set(0, first);
        assertThrows(BusinessException.class, () -> port.offer("d1", invalid, ignored -> { }));
        assertThrows(BusinessException.class, () -> port.offer("d1", List.of(), ignored -> { }));
    }
}
