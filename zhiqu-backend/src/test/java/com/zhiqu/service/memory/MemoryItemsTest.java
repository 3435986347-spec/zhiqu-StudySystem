package com.zhiqu.service.memory;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 用户记忆逐条（第一百四十三轮，docs/memory-plan.md 第 7 步）里不碰库的那几样：按行拆、读的预算、草稿的加 / 改 / 作废。
 * 碰库的（迁移前后拼回来一样、第 41 条写得进、改过的旧条目不再出现）在 {@code MemoryItemsIntegrationTest}。
 */
class MemoryItemsTest {

    private static LongTermMemoryStore.Item item(long id, String text, boolean pinned, String updated) {
        LocalDateTime at = LocalDateTime.parse(updated);
        return new LongTermMemoryStore.Item(id, "- " + text, null, "MANUAL", pinned, at, at, null);
    }

    @Test
    @DisplayName("按行拆：去首尾空白、去空行、整行去重 —— 和原来 mergeItems 的规矩一样，拼回来的全文不变")
    void 按行拆() {
        assertEquals(List.of("- 上午不开会", "- 用 Python"), LongTermMemoryStore.lines("  - 上午不开会\n\n- 用 Python\r\n- 上午不开会\n  "));
        assertEquals("- a\n- b", LongTermMemoryStore.normalize("- a\n\n\n- b\n"));
        assertEquals("上午不开会", LongTermMemoryStore.plainOf("- 上午不开会"));
        assertEquals("上午不开会", LongTermMemoryStore.plainOf("-上午不开会"));
    }

    @Test
    @DisplayName("读的预算：置顶的先进、其余按最近改过的；放不下的整条留在外面（不截半句）、说还有几条；排出来按建的先后")
    void 读的预算() {
        List<LongTermMemoryStore.Item> all = new ArrayList<>();
        all.add(item(1, "很早以前的一条" + "字".repeat(30), false, "2026-01-01T00:00"));
        all.add(item(2, "置顶的一条", true, "2025-01-01T00:00"));
        all.add(item(3, "最近改的一条", false, "2026-11-16T10:00"));
        all.add(item(4, "上个月的一条", false, "2026-10-16T10:00"));
        LongTermMemoryStore.Budgeted b = LongTermMemoryStore.budget(all, 40);
        assertEquals("- 置顶的一条\n- 最近改的一条\n- 上个月的一条", b.text());
        assertEquals(3, b.included());
        assertEquals(4, b.total());
        // 只放得下两条：置顶的一定在（它最旧），另一条是最近改的那条（不是编号最大的上个月那条）
        assertEquals("- 置顶的一条\n- 最近改的一条", LongTermMemoryStore.budget(all, 18).text());
        // 全放得下：全进，顺序是置顶在前、其余按建的先后（同一批条目每次排出来一样）
        assertEquals("- 置顶的一条\n- 很早以前的一条" + "字".repeat(30) + "\n- 最近改的一条\n- 上个月的一条",
                LongTermMemoryStore.budget(all, 10_000).text());
        assertEquals("", LongTermMemoryStore.budget(List.of(), 100).text());
    }

    @Test
    @DisplayName("整理器的输出：一句话 = 加；改 / 作废要指向现有的编号（编的丢掉）；和现有一字不差的加丢掉；改成一样的丢掉")
    void 解析草稿() {
        List<LongTermMemoryStore.Item> current = List.of(item(12, "上午不开会", false, "2026-11-01T00:00"),
                item(13, "用 Python 刷题", false, "2026-11-01T00:00"));
        List<Map<String, Object>> rows = MemoryDraftRows.parse(List.of(
                "周五写周报",
                Map.of("op", "update", "id", 12, "text", "周三上午不开会"),
                Map.of("op", "invalidate", "id", "#13"),
                Map.of("op", "update", "id", 99, "text", "编出来的编号"),
                Map.of("op", "invalidate", "id", 12),
                "上午不开会",
                "- 周五写周报",
                Map.of("op", "update", "id", 13, "text", "用 Python 刷题")), current, 200);
        assertEquals(3, rows.size(), rows.toString());
        assertEquals(Map.of("op", "add", "text", "周五写周报"), rows.get(0));
        // 改成一字不差的（只差空白）：不是改动，丢掉
        assertTrue(MemoryDraftRows.parse(List.of(Map.of("op", "update", "id", 13, "text", "用  Python 刷题")), current, 200).isEmpty());
        assertEquals("update", rows.get(1).get("op"));
        assertEquals(12L, rows.get(1).get("id"));
        assertEquals("周三上午不开会", rows.get(1).get("text"));
        assertEquals("上午不开会", rows.get(1).get("oldText"));
        assertEquals("invalidate", rows.get(2).get("op"));
        assertEquals(13L, rows.get(2).get("id"));
    }

    @Test
    @DisplayName("确认：请求体只能在草稿里挑 —— 草稿里没有的改 / 作废不认；老草稿只有 text 当成加")
    void 确认只能挑() {
        List<Object> draft = List.of(
                Map.of("op", "add", "text", "周五写周报"),
                Map.of("op", "update", "id", 12, "text", "周三上午不开会", "oldText", "上午不开会"),
                "老草稿的一句");
        List<LongTermMemoryStore.Change> all = MemoryDraftRows.changes(draft, null);
        assertEquals(3, all.size());
        assertEquals(LongTermMemoryStore.Change.update(12L, "周三上午不开会"), all.get(1));
        assertEquals(LongTermMemoryStore.Change.add("老草稿的一句"), all.get(2));
        // 请求体只勾了改的那条，另塞一条作废 #7、把 #12 的改法换掉 —— 都不认，改法以草稿为准
        List<LongTermMemoryStore.Change> picked = MemoryDraftRows.changes(draft, List.of(
                Map.of("op", "update", "id", 12, "text", "换成别的"),
                Map.of("op", "invalidate", "id", 7)));
        assertEquals(List.of(LongTermMemoryStore.Change.update(12L, "周三上午不开会")), picked);
        // 老前端只回 {text}：照旧是加
        assertEquals(List.of(LongTermMemoryStore.Change.add("周五写周报")),
                MemoryDraftRows.changes(draft, List.of(Map.of("text", "周五写周报"))));
        assertEquals("#5 x", MemoryDraftRows.listing(List.of(item(5, "x", false, "2026-01-01T00:00"))));
        assertTrue(MemoryDraftRows.changes(draft, List.of()).isEmpty());
    }
}
