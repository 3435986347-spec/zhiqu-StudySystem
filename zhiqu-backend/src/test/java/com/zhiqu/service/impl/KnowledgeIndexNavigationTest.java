package com.zhiqu.service.impl;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.zhiqu.entity.UserKnowledgePage;
import com.zhiqu.mapper.UserKnowledgePageMapper;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class KnowledgeIndexNavigationTest {
    @Test void generatedIndexListsTitlesWithoutCopyingPrivateBodySnippetsAndInternalAttachmentPaths() {
        MapperBuilderAssistant assistant = new MapperBuilderAssistant(new MybatisConfiguration(), "index-test");
        assistant.setCurrentNamespace("index-test"); TableInfoHelper.initTableInfo(assistant, UserKnowledgePage.class);
        UserKnowledgePageMapper mapper = mock(UserKnowledgePageMapper.class);
        UserKnowledgePage first = page("流程图", "![私有图片](/api/knowledge/images/123) 私有测试用户: 99999999999999");
        UserKnowledgePage second = page("测试用例", "appid: 123456789 https://private.example.com/document");
        when(mapper.selectList(any())).thenReturn(List.of(first, second));
        KnowledgeServiceImpl service = new KnowledgeServiceImpl(mapper, null, null, null, null, null, null, null, null);
        String index = ReflectionTestUtils.invokeMethod(service, "buildIndexPageContent", 11L);
        assertNotNull(index);
        assertTrue(index.contains("[[流程图]]")); assertTrue(index.contains("[[测试用例]]"));
        assertFalse(index.contains("/api/knowledge/"), index);
        assertFalse(index.contains("99999999999999"), index);
        assertFalse(index.contains("private.example.com"), index);
        assertEquals(2, index.lines().filter(line -> line.startsWith("- [[")).count());
    }
    private static UserKnowledgePage page(String title, String summary) {
        UserKnowledgePage row = new UserKnowledgePage(); row.setTitle(title); row.setPageType("NOTE"); row.setContentSummary(summary); return row;
    }
}
