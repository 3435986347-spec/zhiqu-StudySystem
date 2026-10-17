package com.zhiqu.service.impl;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.zhiqu.entity.KnowledgePageLink;
import com.zhiqu.entity.KnowledgeSource;
import com.zhiqu.entity.UserKnowledgePage;
import com.zhiqu.mapper.KnowledgePageLinkMapper;
import com.zhiqu.mapper.KnowledgeSourceMapper;
import com.zhiqu.mapper.UserKnowledgePageMapper;
import com.zhiqu.service.knowledge.VaultMarkdownLinks;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 知识图谱的连线（第六十九轮，真浏览器里看到的）：先写的页链向后建的页，写入时目标还不存在，链接存成 targetPageId = null。
 * 健康检查按标题认得出来，图谱不认 —— 两页明明都在，却画成悬空的红虚线、入度少算；同一个弹窗里又写着「1 个悬空链接」。
 * 那 1 个是内置的「Wiki 维护规则」页拿 [[双链]] 当语法举例，每个新账号的健康检查都报它。
 */
class KnowledgeGraphLinksTest {

    private static KnowledgeServiceImpl service(List<UserKnowledgePage> pages, List<KnowledgePageLink> links) {
        MapperBuilderAssistant assistant = new MapperBuilderAssistant(new MybatisConfiguration(), "graph-test");
        assistant.setCurrentNamespace("graph-test");
        TableInfoHelper.initTableInfo(assistant, UserKnowledgePage.class);
        TableInfoHelper.initTableInfo(assistant, KnowledgePageLink.class);
        TableInfoHelper.initTableInfo(assistant, KnowledgeSource.class);
        UserKnowledgePageMapper pageMapper = mock(UserKnowledgePageMapper.class);
        KnowledgePageLinkMapper linkMapper = mock(KnowledgePageLinkMapper.class);
        KnowledgeSourceMapper sourceMapper = mock(KnowledgeSourceMapper.class);
        when(pageMapper.selectList(any())).thenReturn(pages);
        when(linkMapper.selectList(any())).thenReturn(links);
        when(sourceMapper.selectCount(any())).thenReturn(0L);
        return new KnowledgeServiceImpl(pageMapper, null, null, sourceMapper, null, linkMapper, null, null, null);
    }

    private static UserKnowledgePage page(long id, String title) {
        UserKnowledgePage row = new UserKnowledgePage();
        row.setId(id); row.setTitle(title); row.setPageType("TOPIC");
        return row;
    }

    private static KnowledgePageLink link(long id, long source, Long target, String title) {
        KnowledgePageLink row = new KnowledgePageLink();
        row.setId(id); row.setSourcePageId(source); row.setTargetPageId(target); row.setTargetTitle(title); row.setLinkType("WIKI");
        return row;
    }

    @Test
    @DisplayName("目标页后来才建：图谱按（和健康检查同一套）规范化标题认回来 —— 连线有目标、入度算上；真不存在的照样悬空")
    @SuppressWarnings("unchecked")
    void 后建的目标页按标题认回来() {
        KnowledgeServiceImpl service = service(
                List.of(page(1, "官网改版"), page(2, "用户访谈结论（9 月）")),
                List.of(link(10, 1, null, "用户访谈结论（9月）"),   // 写入时第 2 页还没有；标题里少一个空格也是同一页
                        link(11, 2, 1L, "官网改版"),
                        link(12, 1, null, "不存在的页")));
        Map<String, Object> graph = service.graph(7L);
        List<Map<String, Object>> links = (List<Map<String, Object>>) graph.get("links");
        assertEquals(2L, links.get(0).get("targetPageId"), "后建的目标页没认回来：" + links.get(0));
        assertEquals(1L, links.get(1).get("targetPageId"));
        assertNull(links.get(2).get("targetPageId"), "真不存在的目标被硬配上了一页");
        List<Map<String, Object>> nodes = (List<Map<String, Object>>) graph.get("nodes");
        assertEquals(1, nodes.get(1).get("degree"), "后建的那页被引用一次，入度没算上");
        assertEquals(1, nodes.get(0).get("degree"));
        List<Map<String, Object>> missing = (List<Map<String, Object>>) graph.get("missingTargets");
        assertEquals(List.of(12L), missing.stream().map(row -> row.get("id")).toList(), "悬空链接的个数和画出来的不一致");
    }

    @Test
    @DisplayName("「Wiki 维护规则」拿 [[双链]] 当语法举例时写成行内代码：解析出来没有链接，健康检查不再给每个新账号报一个悬空链接")
    void 维护规则里的举例不是链接() {
        String schema = ReflectionTestUtils.invokeMethod(service(List.of(), List.of()), "defaultSchemaContent");
        assertTrue(schema != null && schema.contains("[[双链]]"), "维护规则不再讲双链了，判据要跟着改");
        assertEquals(List.of(), VaultMarkdownLinks.read(schema).stream().filter(VaultMarkdownLinks.Link::wiki).map(VaultMarkdownLinks.Link::target).toList(),
                "维护规则里的举例被当成了链接");
    }
}
