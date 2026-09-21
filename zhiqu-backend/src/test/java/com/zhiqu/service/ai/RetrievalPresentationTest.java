package com.zhiqu.service.ai;

import com.zhiqu.service.ai.WebSearchProvider.SearchResult;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 检索结果的呈现 —— 这批逻辑刚从 {@code AiServiceImpl} 里拆出来，成了纯函数。
 *
 * <h2>为什么这批判据现在才有</h2>
 *
 * <p>它们在 5770 行的那个类里时，要测就得把整个 Spring 上下文或者一堆 mock 立起来，
 * 于是一直没人测。拆出来之后是<b>给什么出什么</b>的纯函数，
 * 一个 mock 都不用 —— 这才是这一刀真正换到的东西，不是「少了 89 行」。
 */
class RetrievalPresentationTest {

    private static SearchResult hit(String title, String status) {
        return new SearchResult(title, "https://example.com/" + title, "摘要 " + title, "WEB", status);
    }

    // ── 「抓取成功」的判定 ────────────────────────────────────────────────

    /**
     * 两个重载必须给出<b>同样</b>的答案。
     *
     * <p>它们原来是两份各自写的实现（一份吃 Map、一份吃 SearchResult），当时语义碰巧一致。
     * 合并成一个私有判定之后这条判据仍然值得留着：它钉的是「同一条引用在提示词里和在
     * 前端状态里必须算同一种结果」。谁哪天又拆成两份，这条会红。
     */
    @Test
    void 两个重载对同一状态必须给出同样答案() {
        for (String status : new String[]{null, "", "   ", "OK", "ok", "Ok", "SUCCESS", "success",
                                          "FAILED", "failed", "TIMEOUT", "403", "PARTIAL"}) {
            boolean fromRecord = RetrievalPresentation.isSuccessfulCitation(hit("x", status));
            boolean fromMap = RetrievalPresentation.isSuccessfulCitation(
                    status == null ? Map.of() : Map.of("status", status));
            assertEquals(fromRecord, fromMap,
                    "状态「" + status + "」在两个重载上答案不同 —— 同一条引用会在提示词里算成功、"
                            + "在前端状态里算失败，而两边都不报错");
        }
    }

    @Test
    void 空状态算成功而明确失败不算() {
        assertTrue(RetrievalPresentation.isSuccessfulCitation(hit("a", null)),
                "没给状态的旧数据要当成功 —— 否则历史引用会集体变成「失败」");
        assertTrue(RetrievalPresentation.isSuccessfulCitation(hit("a", "")));
        assertTrue(RetrievalPresentation.isSuccessfulCitation(hit("a", "  ")), "只有空白也算没给");
        assertTrue(RetrievalPresentation.isSuccessfulCitation(hit("a", "ok")), "大小写不敏感");
        assertFalse(RetrievalPresentation.isSuccessfulCitation(hit("a", "FAILED")));
        assertFalse(RetrievalPresentation.isSuccessfulCitation(hit("a", "TIMEOUT")));
    }

    @Test
    void null输入不得抛异常() {
        assertTrue(RetrievalPresentation.isSuccessfulCitation((SearchResult) null));
        assertTrue(RetrievalPresentation.isSuccessfulCitation((Map<String, Object>) null));
        assertEquals(List.of(), RetrievalPresentation.citationRows(null));
        assertEquals(0, RetrievalPresentation.retrievalStatus(null).get("successCount"));
    }

    // ── 状态汇总 ──────────────────────────────────────────────────────────

    @Test
    void 状态汇总要把成功与失败分开数() {
        Map<String, Object> status = RetrievalPresentation.retrievalStatus(List.of(
                hit("a", "OK"), hit("b", "FAILED"), hit("c", null), hit("d", "TIMEOUT")));

        assertEquals(2, status.get("successCount"), "OK 与「没给状态」都算成功");
        assertEquals(2, status.get("failedCount"));
        assertEquals(2, ((List<?>) status.get("errors")).size(),
                "失败的要逐条列出来，否则用户只看到一个数字，不知道是哪一条抓失败了");
    }

    /** 空输入：三个字段都要在，而不是缺字段 —— 前端读不到会显示 undefined。 */
    @Test
    void 没有引用时状态仍要结构完整() {
        Map<String, Object> status = RetrievalPresentation.retrievalStatus(List.of());
        assertEquals(0, status.get("successCount"));
        assertEquals(0, status.get("failedCount"));
        assertEquals(List.of(), status.get("errors"));
    }

    @Test
    void 全部失败时成功数为零() {
        Map<String, Object> status = RetrievalPresentation.retrievalStatus(
                List.of(hit("a", "FAILED"), hit("b", "403")));
        assertEquals(0, status.get("successCount"));
        assertEquals(2, status.get("failedCount"));
    }

    // ── 提示块拼装 ────────────────────────────────────────────────────────

    /**
     * 没有检索结果时，原文<b>一个字都不能变</b>。
     *
     * <p>加一个空的「参考资料」小标题看起来无害，实际会让模型以为检索过但什么也没搜到，
     * 于是它会为此道歉或者解释 —— 而用户压根没要求检索。
     */
    @Test
    void 没有检索结果时提示词保持原样() {
        assertEquals("原始问题", RetrievalPresentation.withWebSearchContext("原始问题", List.of()));
        assertEquals("原始问题", RetrievalPresentation.withWebSearchContext("原始问题", null));
        assertEquals("原始问题", RetrievalPresentation.withNotebookContext("原始问题", List.of()));
        assertEquals("原始问题", RetrievalPresentation.withNotebookContext("原始问题", null));
    }

    @Test
    void 有检索结果时原文必须仍然在里面() {
        String out = RetrievalPresentation.withWebSearchContext("原始问题", List.of(hit("甲", "OK")));
        assertTrue(out.contains("原始问题"), "拼装之后用户原话不能丢。实际：" + out);
        assertTrue(out.length() > "原始问题".length(), "应当确实加了资料块");
    }

    /** 全部抓取失败时不该把失败内容当资料喂给模型。 */
    @Test
    void 抓取失败的条目不得当成资料() {
        String out = RetrievalPresentation.withWebSearchContext("原始问题", List.of(hit("坏页", "FAILED")));
        assertFalse(out.contains("摘要 坏页"),
                "抓取失败的摘要不该进提示词 —— 模型会把错误页面的内容当成检索到的事实。实际：" + out);
    }
}
