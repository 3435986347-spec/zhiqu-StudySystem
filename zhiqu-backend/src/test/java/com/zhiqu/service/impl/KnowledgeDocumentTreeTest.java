package com.zhiqu.service.impl;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.zhiqu.entity.KnowledgeOperationLog;
import com.zhiqu.entity.KnowledgePageLink;
import com.zhiqu.entity.UserKnowledgePage;
import com.zhiqu.mapper.KnowledgeOperationLogMapper;
import com.zhiqu.mapper.KnowledgePageLinkMapper;
import com.zhiqu.mapper.KnowledgePatchSetMapper;
import com.zhiqu.mapper.KnowledgeSourceMapper;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.mapper.UserKnowledgePageMapper;
import com.zhiqu.mapper.UserKnowledgeRevisionMapper;
import com.zhiqu.rag.RagIndexJobService;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 打开知识 Wiki 这一路（documentTree）的两件事：
 * <ol>
 *   <li>目录树不带正文 —— 原来把每一页都解密塞进来，前端却从不用它（打开某页时还会再取一遍）；</li>
 *   <li>系统页（index / log / 维护规则）内容没变就不写库 —— 原来每次打开都重新加密、UPDATE、重建链接，
 *       一次「读」变成三次写。</li>
 * </ol>
 */
class KnowledgeDocumentTreeTest {

    @BeforeAll
    static void tableInfo() {
        MapperBuilderAssistant assistant = new MapperBuilderAssistant(new MybatisConfiguration(), "");
        for (Class<?> c : new Class<?>[]{UserKnowledgePage.class, KnowledgePageLink.class, KnowledgeOperationLog.class}) {
            TableInfoHelper.initTableInfo(assistant, c);
        }
    }

    private final UserKnowledgePageMapper pageMapper = mock(UserKnowledgePageMapper.class);
    private final SensitiveCryptoService crypto = spy(new SensitiveCryptoService("0123456789abcdef0123456789abcdef"));
    private final KnowledgeServiceImpl service = new KnowledgeServiceImpl(pageMapper, mock(SysUserMapper.class),
            mock(UserKnowledgeRevisionMapper.class), mock(KnowledgeSourceMapper.class), mock(KnowledgePatchSetMapper.class),
            mock(KnowledgePageLinkMapper.class), mock(KnowledgeOperationLogMapper.class), crypto, mock(RagIndexJobService.class));

    private UserKnowledgePage page(long id, String title, String type, String content, int order, int pinned) {
        UserKnowledgePage p = new UserKnowledgePage();
        p.setId(id);
        p.setUserId(1L);
        p.setTitle(title);
        p.setPageType(type);
        p.setSortOrder(order);
        p.setPinned(pinned);
        p.setEncryptedContent(crypto.encrypt(content));
        p.setContentSummary(content.length() > 20 ? content.substring(0, 20) : content);
        p.setVersion(1);
        p.setUpdatedAt(LocalDateTime.of(2026, 9, 24, 10, 0));
        return p;
    }

    @Test
    @DisplayName("目录树不解密、不返回任何一页的正文，只给摘要")
    void 树里没有正文() {
        List<UserKnowledgePage> pages = new ArrayList<>(List.of(
                page(1, "index", "INDEX", "旧的 index", 1, 1),
                page(2, "log", "LOG", "旧的 log", 2, 1),
                page(3, "Wiki 维护规则", "SCHEMA", "旧规则", 3, 1)));
        List<String> userCiphertexts = new ArrayList<>();
        for (int i = 0; i < 50; i++) {
            UserKnowledgePage p = page(100 + i, "笔记 " + i, "NOTE", "第 " + i + " 页的很长很长的正文……".repeat(50), 10 + i, 0);
            pages.add(p);
            userCiphertexts.add(p.getEncryptedContent());
        }
        when(pageMapper.selectList(any())).thenReturn(pages);
        when(pageMapper.updateById(any(UserKnowledgePage.class))).thenReturn(1);
        clearInvocations(crypto);

        List<Map<String, Object>> tree = service.documentTree(1L);

        for (String c : userCiphertexts) {
            verify(crypto, never()).decrypt(c);
        }
        List<Map<String, Object>> flat = new ArrayList<>();
        flatten(tree, flat);
        assertEquals(53, flat.size());
        for (Map<String, Object> node : flat) {
            assertFalse(node.containsKey("content"), "目录树节点不该带正文：" + node.get("title"));
        }
    }

    @Test
    @DisplayName("系统页：第一次打开把旧内容刷新（写库），内容没变的第二次打开一个字都不写")
    void 系统页没变不写() {
        List<UserKnowledgePage> pages = new ArrayList<>(List.of(
                page(1, "index", "INDEX", "旧的 index", 1, 1),
                page(2, "log", "LOG", "旧的 log", 2, 1),
                page(3, "Wiki 维护规则", "SCHEMA", "旧规则", 3, 1),
                page(4, "我的笔记", "NOTE", "正文", 10, 0)));
        when(pageMapper.selectList(any())).thenReturn(pages);
        when(pageMapper.updateById(any(UserKnowledgePage.class))).thenReturn(1);

        service.documentTree(1L);
        verify(pageMapper, atLeastOnce()).updateById(any(UserKnowledgePage.class));

        clearInvocations(pageMapper);
        service.documentTree(1L);
        verify(pageMapper, never()).updateById(any(UserKnowledgePage.class));
        verify(pageMapper, never()).insert(any(UserKnowledgePage.class));
    }

    @SuppressWarnings("unchecked")
    private static void flatten(List<Map<String, Object>> nodes, List<Map<String, Object>> out) {
        for (Map<String, Object> n : nodes) {
            out.add(n);
            flatten((List<Map<String, Object>>) n.get("children"), out);
        }
    }
}
