package com.zhiqu.service.impl;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.KnowledgeSource;
import com.zhiqu.mapper.*;
import com.zhiqu.rag.RagIndexJobService;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.Arrays;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

/** A parsed source remains inspectable without writing a knowledge page or exposing another user's body. */
class KnowledgeSourceAccessTest {
    private final KnowledgeSourceMapper sources = mock(KnowledgeSourceMapper.class);
    private final UserKnowledgePageMapper pages = mock(UserKnowledgePageMapper.class);
    private final UserKnowledgeRevisionMapper revisions = mock(UserKnowledgeRevisionMapper.class);
    private final KnowledgePatchSetMapper patches = mock(KnowledgePatchSetMapper.class);
    private final SensitiveCryptoService crypto = new SensitiveCryptoService("0123456789abcdef0123456789abcdef");
    private final KnowledgeServiceImpl service = new KnowledgeServiceImpl(pages, mock(SysUserMapper.class), revisions,
            sources, patches, mock(KnowledgePageLinkMapper.class), mock(KnowledgeOperationLogMapper.class),
            crypto, mock(RagIndexJobService.class));
    private final KnowledgeSource source = new KnowledgeSource();

    @BeforeEach
    void setup() {
        MapperBuilderAssistant assistant = new MapperBuilderAssistant(new MybatisConfiguration(), "wiki-source-test");
        assistant.setCurrentNamespace("wiki-source-test");
        TableInfoHelper.initTableInfo(assistant, KnowledgeSource.class);
        source.setId(55L);
        source.setUserId(1L);
        source.setTitle("我的上传资料");
        source.setSourceType("FILE");
        source.setSourceRef("file:notes.txt");
        source.setContentSummary("正文摘要");
        source.setEncryptedContent(crypto.encrypt("完整来源正文，不应在其他用户处出现"));
        when(sources.selectOne(any())).thenAnswer(invocation -> {
            LambdaQueryWrapper<KnowledgeSource> wrapper = invocation.getArgument(0);
            wrapper.getSqlSegment();
            return wrapper.getParamNameValuePairs().containsValue(55L)
                    && wrapper.getParamNameValuePairs().containsValue(1L) ? source : null;
        });
    }

    private Method detailMethod() {
        Method method = Arrays.stream(service.getClass().getMethods())
                .filter(candidate -> candidate.getName().equals("sourceDetail"))
                .findFirst().orElse(null);
        assertNotNull(method, "解析后必须有本人可读取的来源详情，不能只显示成功消息而没有可查看的内容");
        return method;
    }

    @Test
    void ownerCanReadCompleteSourceWithoutCreatingPageOrDraft() throws Exception {
        @SuppressWarnings("unchecked")
        Map<String, Object> result = (Map<String, Object>) detailMethod().invoke(service, 1L, 55L);
        assertEquals("完整来源正文，不应在其他用户处出现", result.get("content"));
        assertEquals("我的上传资料", result.get("title"));
        assertFalse(result.containsKey("encryptedContent"));
        verifyNoInteractions(pages, revisions, patches);
    }

    @Test
    void otherUserCannotReadSourceBodyOrMetadata() {
        Method method = detailMethod();
        InvocationTargetException failure = assertThrows(InvocationTargetException.class,
                () -> method.invoke(service, 2L, 55L));
        assertInstanceOf(BusinessException.class, failure.getCause());
        assertFalse(failure.getCause().getMessage().contains("完整来源正文"));
        assertFalse(failure.getCause().getMessage().contains("我的上传资料"));
        verifyNoInteractions(pages, revisions, patches);
    }
}
