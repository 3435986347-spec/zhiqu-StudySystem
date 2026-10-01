package com.zhiqu.service.impl;

import com.zhiqu.NodeRunner;
import com.zhiqu.SourceText;
import com.zhiqu.entity.KnowledgeSource;
import com.zhiqu.mapper.KnowledgeOperationLogMapper;
import com.zhiqu.mapper.KnowledgePageLinkMapper;
import com.zhiqu.mapper.KnowledgePatchSetMapper;
import com.zhiqu.mapper.KnowledgeSourceMapper;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.mapper.UserKnowledgePageMapper;
import com.zhiqu.mapper.UserKnowledgeRevisionMapper;
import com.zhiqu.rag.RagIndexJobService;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.mock.web.MockMultipartFile;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Raw Source 原文超过上限时只存前面一段 —— 但要说出来。原来粘贴 12000、上传 20000，截了一个字都不说：
 * 两百页的 PDF 导进来只剩前几页，用户以为整份都在自己的 Wiki 里。
 */
class KnowledgeSourceTruncationTest {

    private final KnowledgeSourceMapper sources = mock(KnowledgeSourceMapper.class);
    private final SensitiveCryptoService crypto = new SensitiveCryptoService("0123456789abcdef0123456789abcdef");
    private final KnowledgeServiceImpl service = new KnowledgeServiceImpl(mock(UserKnowledgePageMapper.class), mock(SysUserMapper.class),
            mock(UserKnowledgeRevisionMapper.class), sources, mock(KnowledgePatchSetMapper.class),
            mock(KnowledgePageLinkMapper.class), mock(KnowledgeOperationLogMapper.class), crypto, mock(RagIndexJobService.class));
    private final ArgumentCaptor<KnowledgeSource> saved = ArgumentCaptor.forClass(KnowledgeSource.class);

    KnowledgeSourceTruncationTest() {
        doAnswer(inv -> { ((KnowledgeSource) inv.getArgument(0)).setId(1L); return 1; }).when(sources).insert(saved.capture());
        when(sources.selectById(any())).thenAnswer(inv -> saved.getValue());
    }

    private String stored() {
        return crypto.decrypt(saved.getValue().getEncryptedContent());
    }

    @Test
    @DisplayName("粘贴导入：超过上限只存前 20000 字，回包里说 {kept, total}；上限与上传同一个（原来粘贴只有 12000）")
    void 粘贴超长要说() {
        String content = "字".repeat(30_000);
        Map<String, Object> row = service.createSource(1L, Map.of("title", "长笔记", "content", content));
        assertEquals(KnowledgeServiceImpl.MAX_SOURCE_CHARS, stored().length());
        assertEquals(Map.of("kept", KnowledgeServiceImpl.MAX_SOURCE_CHARS, "total", 30_000), row.get("truncated"));
    }

    @Test
    @DisplayName("上传导入：超过上限同样说出来")
    void 上传超长要说() {
        byte[] text = "学".repeat(25_000).getBytes(StandardCharsets.UTF_8);
        Map<String, Object> row = service.createSourceFromUpload(1L, new MockMultipartFile("file", "notes.txt", "text/plain", text), null);
        assertEquals(KnowledgeServiceImpl.MAX_SOURCE_CHARS, stored().length());
        assertEquals(Map.of("kept", KnowledgeServiceImpl.MAX_SOURCE_CHARS, "total", 25_000), row.get("truncated"));
    }

    @Test
    @DisplayName("没超过：原文完整存下，回包里没有 truncated（正好等于上限也不算截断）")
    void 没超不说() {
        Map<String, Object> exact = service.createSource(1L, Map.of("title", "刚好", "content", "a".repeat(KnowledgeServiceImpl.MAX_SOURCE_CHARS)));
        assertFalse(exact.containsKey("truncated"));
        assertEquals(KnowledgeServiceImpl.MAX_SOURCE_CHARS, stored().length());
        Map<String, Object> small = service.createSource(1L, Map.of("title", "短", "content", "一段短笔记"));
        assertFalse(small.containsKey("truncated"));
        assertEquals("一段短笔记", stored());
    }

    @Test
    @DisplayName("页面把截断说给用户：两个导入入口都拿回包过 truncatedNote，它读的是 truncated")
    void 页面要说出来() throws Exception {
        String js = SourceText.stripComments(Files.readString(NodeRunner.API_JS));
        for (String call : new String[]{"api.upload('/knowledge/sources/upload'", "api.post('/knowledge/sources',"}) {
            int at = js.indexOf(call);
            assertTrue(at > 0, "找不到 " + call);
            String after = js.substring(at, Math.min(js.length(), at + 300));
            assertTrue(after.contains("truncatedNote(saved)"), call + " 之后没有把截断告诉用户：\n" + after);
        }
        int fn = js.indexOf("function truncatedNote(saved)");
        assertTrue(fn > 0 && js.substring(fn, fn + 200).contains("saved.truncated"), "truncatedNote 没读回包里的 truncated");
    }
}
