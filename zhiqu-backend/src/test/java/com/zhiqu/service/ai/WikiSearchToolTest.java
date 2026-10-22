package com.zhiqu.service.ai;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.service.KnowledgeService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * search_wiki 认页面类型（第四十五轮）。用户 2026-10-06：「我明明有目标页面，就是27考研」—— 命令行里问「我现在有哪些计划」，
 * 模型按「目标」「GOAL」「项目」搜了三次，回答「知识 Wiki 里也没有查到目标（GOAL）或项目（PROJECT）类的页面」。
 * 原因：匹配只看标题、摘要、正文，页面类型不在里面；也没有「列出某一类全部页面」的办法。网页的 AI 助手、命令行、zhiqu mcp 用的都是这一个工具。
 */
class WikiSearchToolTest {

    private final ObjectMapper json = new ObjectMapper();

    private static Map<String, Object> page(String title, String type, String content) {
        Map<String, Object> p = new HashMap<>();
        p.put("title", title);
        p.put("pageType", type);
        p.put("content", content);
        p.put("summary", "");
        return p;
    }

    private WikiToolAgent agent(List<Map<String, Object>> pages) {
        KnowledgeService knowledge = mock(KnowledgeService.class);
        when(knowledge.listPages(anyLong())).thenReturn(pages);
        return new WikiToolAgent(knowledge, null, json);
    }

    private static List<Map<String, Object>> sample() {
        List<Map<String, Object>> pages = new ArrayList<>();
        pages.add(page("index", "INDEX", "目录"));
        pages.add(page("27考研", "GOAL", "数学一 + 英语一，12 月下旬初试；每天两套真题"));
        pages.add(page("官网改版", "PROJECT", "首页需求、设计稿、上线排期"));
        pages.add(page("老的日程", "SCHEDULE", "旧数据里的计划页"));
        pages.add(page("周报模板", "NOTE", "每周五下午写"));
        pages.add(page("没写类型的一页", null, "随手记"));
        return pages;
    }

    @SuppressWarnings("unchecked")
    private static List<String> titles(Map<String, Object> out) {
        List<String> t = new ArrayList<>();
        for (Map<String, Object> row : (List<Map<String, Object>>) out.get("pages")) t.add(String.valueOf(row.get("title")));
        return t;
    }

    private static Map<String, Object> args(String query, String type) {
        Map<String, Object> a = new LinkedHashMap<>();
        if (query != null) a.put("query", query);
        if (type != null) a.put("type", type);
        return a;
    }

    @Test
    @DisplayName("按「目标」「GOAL」「goal」搜：标题和正文里没写「目标」的目标页也找得到（原来找不到）")
    void 关键词匹配页面类型() {
        WikiToolAgent a = agent(sample());
        for (String q : List.of("目标", "GOAL", "goal")) {
            assertEquals(List.of("27考研"), titles(a.searchWiki(1L, args(q, null))), "按「" + q + "」搜");
        }
        assertEquals(List.of("官网改版", "老的日程"), titles(a.searchWiki(1L, args("计划", null))), "按「计划」搜：PROJECT 和老数据里的 SCHEDULE 都算");
    }

    @Test
    @DisplayName("只给 type、不给关键词：列出这一类的全部页面；代码、中文名、「项目」都认")
    void 按类型列出() {
        WikiToolAgent a = agent(sample());
        assertEquals(List.of("27考研"), titles(a.searchWiki(1L, args("", "GOAL"))));
        assertEquals(List.of("27考研"), titles(a.searchWiki(1L, args(null, "目标"))));
        assertEquals(List.of("官网改版", "老的日程"), titles(a.searchWiki(1L, args(null, "项目"))));
        assertEquals(List.of("官网改版"), titles(a.searchWiki(1L, args("首页", "project"))), "关键词和类型一起用");
        assertEquals(List.of("index", "周报模板", "没写类型的一页"), titles(a.searchWiki(1L, args(null, "备注"))), "没写类型的、认不出的类型算备注");
    }

    @Test
    @DisplayName("关键词按空格拆开、每个都要中（「27 考研」中间多个空格原来就不中）")
    void 拆词() {
        WikiToolAgent a = agent(sample());
        assertEquals(List.of("27考研"), titles(a.searchWiki(1L, args("27 考研", null))));
        assertEquals(List.of("27考研"), titles(a.searchWiki(1L, args("考研  真题", null))));
        assertEquals(List.of(), titles(a.searchWiki(1L, args("考研 首页", null))), "两个词不在同一页：不算中");
        // 中文输入法的全角空格（U+3000）：Java 的 \\s 不认它（第四十七轮 review）
        assertEquals(List.of("27考研"), titles(a.searchWiki(1L, args("27\u3000考研", null))), "全角空格也要拆开");
    }

    @Test
    @DisplayName("认不出的类型照实说可用的有哪些（不当成「备注」悄悄列一堆别的）")
    void 认不出的类型() {
        Map<String, Object> out = agent(sample()).searchWiki(1L, args(null, "TODO"));
        assertNull(out.get("pages"));
        assertTrue(String.valueOf(out.get("error")).contains("TODO") && String.valueOf(out.get("error")).contains("GOAL（目标）"), String.valueOf(out));
    }

    @Test
    @DisplayName("没列全时说一共几页（原来只给前 12 条，模型以为就这么多）")
    void 总数() {
        List<Map<String, Object>> pages = new ArrayList<>();
        for (int i = 0; i < WikiToolAgent.SEARCH_LIMIT + 5; i++) pages.add(page("目标 " + i, "GOAL", ""));
        Map<String, Object> out = agent(pages).searchWiki(1L, args(null, "GOAL"));
        assertEquals(WikiToolAgent.SEARCH_LIMIT, out.get("count"));
        assertEquals(WikiToolAgent.SEARCH_LIMIT + 5, out.get("total"));
        assertTrue(String.valueOf(out.get("note")).contains("一共 " + (WikiToolAgent.SEARCH_LIMIT + 5) + " 页"), String.valueOf(out.get("note")));
        Map<String, Object> few = agent(sample()).searchWiki(1L, args(null, "GOAL"));
        assertFalse(few.containsKey("note"), "列全了就不要多说");
    }

    @Test
    @DisplayName("接线：下发的 search_wiki 有 type 参数、query 不再必填；executeWikiTool 走的就是这一条")
    @SuppressWarnings("unchecked")
    void 接线() throws Exception {
        WikiToolAgent a = agent(sample());
        Map<String, Object> search = a.buildWikiTools(false).stream()
                .map(t -> (Map<String, Object>) t.get("function"))
                .filter(f -> "search_wiki".equals(f.get("name"))).findFirst().orElseThrow();
        Map<String, Object> params = (Map<String, Object>) search.get("parameters");
        assertNotNull(((Map<String, Object>) params.get("properties")).get("type"), "search_wiki 没有 type 参数");
        assertEquals(List.of(), params.get("required"), "query 还是必填 —— 只想按类型列出时模型没法不给关键词");
        assertTrue(String.valueOf(search.get("description")).contains("type 填那一类、query 留空"), "工具说明里没告诉模型怎么列出某一类");
        String out = a.executeWikiTool(1L, "search_wiki", "{\"type\":\"目标\"}", new WikiToolAgent.WikiLoopState()).result;
        Map<String, Object> parsed = json.readValue(out, new TypeReference<Map<String, Object>>() {});
        assertEquals(List.of("27考研"), titles(parsed));
        // 网页 code agent 那一侧的「正在查……」：只给类型时不能是「查知识库「」」
        assertEquals("查知识库里的目标页", CodeToolNarration.describeCall("search_wiki", "{\"type\":\"GOAL\"}"));
        assertEquals("查知识库「考研」（目标页）", CodeToolNarration.describeCall("search_wiki", "{\"query\":\"考研\",\"type\":\"目标\"}"));
    }
}
