package com.zhiqu.rag;

import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 候选行键名的单一定义，以及桶键缺失时的响亮失败。
 *
 * <p>这是本仓库第五次「共享词表没有单一定义」。前四次的形状是作业类型、删除作用域、
 * 命名空间、fence key；这次是<b>生产端与消费端之间的 map 键名</b>，
 * 而它比前四次更静默 —— {@code ContextBudgeter} 用 {@code getOrDefault(..., "")} 取值，
 * 两侧不同步时不报错，只是把所有候选塌进同一个桶，
 * 于是 {@code maxPerSource=3} 作用在整个候选集上，检索结果无声地少一截。
 */
class CandidateKeysTest {

    private static Map<String, Object> row(String sourceType, Object sourceId) {
        Map<String, Object> row = new LinkedHashMap<>();
        if (sourceType != null) row.put(CandidateKeys.SOURCE_TYPE, sourceType);
        if (sourceId != null) row.put(CandidateKeys.SOURCE_ID, sourceId);
        row.put(CandidateKeys.CONTENT, "正文");
        return row;
    }

    @Test
    void 桶键由两段组成且不同源不撞桶() {
        assertEquals("TEXT:7", CandidateKeys.sourceKeyOf(row("TEXT", 7L)));
        assertEquals("WIKI_PAGE:wiki:7", CandidateKeys.sourceKeyOf(row("WIKI_PAGE", "wiki:7")));
    }

    /**
     * 缺任意一段都必须抛，<b>不能回落成空串</b>。
     *
     * <p>回落的后果不是「这一行算错桶」，是<b>所有行落进同一个桶</b> ——
     * 而它不抛异常、不记指标，表现只是检索回来的东西比预期少。
     * 这与 {@code RagIndexWorker.unitScopeFor} 对不认识的作用域抛出是同一个取舍。
     */
    @Test
    void 缺桶键即抛而不是回落成空串() {
        assertThrows(IllegalStateException.class, () -> CandidateKeys.sourceKeyOf(row(null, 7L)));
        assertThrows(IllegalStateException.class, () -> CandidateKeys.sourceKeyOf(row("TEXT", null)));

        IllegalStateException error = assertThrows(IllegalStateException.class,
                () -> CandidateKeys.sourceKeyOf(row(null, null)));
        assertTrue(error.getMessage().contains("同一个桶"),
                "错误消息要说清后果，否则下一个人只会看到「少了个键」而不知道它会塌成什么");
    }

    /**
     * 每源配额确实按桶键生效 —— 这条是第三条新基准的前提，先在这里钉住。
     *
     * <p>两个不同的源、每个 4 条候选：{@code maxPerSource=3} 生效时各留 3 条。
     * 若桶键塌成一个，留下的就是总共 3 条 —— 两种结果差得很远，不会看错。
     */
    @Test
    void 每源配额按桶键分桶而不是全局() {
        RagProperties properties = new RagProperties();
        ContextBudgeter budgeter = new ContextBudgeter(properties);

        java.util.List<Map<String, Object>> preferred = new java.util.ArrayList<>();
        for (String type : java.util.List.of("TEXT", "WIKI_PAGE")) {
            for (int index = 0; index < 4; index++) {
                Map<String, Object> row = row(type, type.equals("TEXT") ? 7L : "wiki:9");
                row.put(CandidateKeys.CHUNK_ID, (long) (type.hashCode() & 0xffff) * 100 + index);
                preferred.add(row);
            }
        }

        java.util.List<Map<String, Object>> selected = budgeter.select(preferred, java.util.List.of(), 2);

        assertEquals(6, selected.size(),
                "两个桶各留 maxPerSource=3；塌成一个桶的话总共只会留 3 条");
    }
}

// ── 扰动记录（2026-08-09 实测）──────────────────────────────────────────────
//
//   N1  改常量的**值**（sourceId → unitId），生产端两侧跟随
//         · 只跑 CandidateKeysTest ..................... GREEN ✓（阳性对照）
//         · 跑 ContextBudgeterCharacterizationTest ..... RED（4 errors）
//   N2  sourceKeyOf 回落成空串（去掉缺失即抛） ......... RED ✓
//
// **N1 我事先声明的预期是「全绿」，实测不是 —— 而错的是预期，不是代码。**
// ContextBudgeterCharacterizationTest 里有 7 处硬编码的 "sourceId"/"sourceType"，
// 改名它必红。
//
// 关键在于：**那是它该做的事，不是收敛没做完。**
// golden master 钉的是候选行的**外部形状**，而键名改了就是外部形状改了。
// 如果为了让 N1 全绿而把夹具也改成引用 CandidateKeys.SOURCE_ID，
// 它就会跟着重命名一起漂移、从此对键名改动完全不敏感 ——
// 那正是本项目记过的「协议版本断言两侧用同一个常量」那个物种。
//
// 所以阳性对照的正确措辞要带定义域：
//   **在生产代码内部，重命名是编译期改动；而 golden master 刻意留在收敛之外。**
// 不带定义域的「全绿」是一句会诱导人去弱化夹具的话。
