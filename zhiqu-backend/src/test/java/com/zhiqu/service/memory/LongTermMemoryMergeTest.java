package com.zhiqu.service.memory;

import com.zhiqu.common.BusinessException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 长期记忆满了要照实说（第一百三十七轮，docs/memory-plan.md 第 1 步）。
 * 原来合并后取前 2000 字：新条目排在最后，被截掉的正是用户刚确认的那几条，接口照样回成功。
 */
class LongTermMemoryMergeTest {

    @Test
    @DisplayName("放得下：按整行去重、补上「- 」，顺序不变")
    void 放得下() {
        String merged = LongTermMemoryStore.mergeItems("- 上午不开会\n\n- 用 Python", List.of("用 Python", "- 上午不开会", "周五写周报", " "));
        assertEquals("- 上午不开会\n- 用 Python\n- 周五写周报", merged);
    }

    @Test
    @DisplayName("放不下：拒绝并说清楚，一条都不写；不是悄悄截掉尾巴")
    void 放不下() {
        List<String> lines = new ArrayList<>();
        for (int i = 0; i < 39; i++) lines.add("- 第 " + i + " 条：" + "记".repeat(40));
        String existing = String.join("\n", lines);
        assertTrue(existing.length() < LongTermMemoryStore.MAX_LENGTH);
        BusinessException e = assertThrows(BusinessException.class,
                () -> LongTermMemoryStore.mergeItems(existing, List.of("新确认的这一条".repeat(20))));
        assertTrue(e.getMessage().contains("放不下") && e.getMessage().contains("一条都没写进去"), e.getMessage());
        // 没有新条目（全是重复的）不算放不下：旧数据本来就这么长
        assertEquals(existing, LongTermMemoryStore.mergeItems(existing, List.of("- 第 3 条：" + "记".repeat(40))));
    }
}
