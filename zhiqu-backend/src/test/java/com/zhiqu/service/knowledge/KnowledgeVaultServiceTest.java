package com.zhiqu.service.knowledge;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.KnowledgeAttachment;
import com.zhiqu.entity.KnowledgeOperationLog;
import com.zhiqu.entity.KnowledgePageLink;
import com.zhiqu.entity.UserKnowledgePage;
import com.zhiqu.mapper.KnowledgeAttachmentMapper;
import com.zhiqu.mapper.KnowledgeOperationLogMapper;
import com.zhiqu.mapper.KnowledgePageLinkMapper;
import com.zhiqu.mapper.SysUserMapper;
import com.zhiqu.mapper.UserKnowledgePageMapper;
import com.zhiqu.rag.RagIndexJobService;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockMultipartFile;

import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.*;

/** Synthetic Obsidian layout; no real vault, database, app, Docker or model calls. */
class KnowledgeVaultServiceTest {
    private final Map<Long, UserKnowledgePage> pages = new LinkedHashMap<>();
    private final Map<Long, KnowledgeAttachment> files = new LinkedHashMap<>();
    private final List<KnowledgePageLink> relationships = new ArrayList<>();
    private final List<KnowledgeOperationLog> operations = new ArrayList<>();
    private final SensitiveCryptoService crypto = new SensitiveCryptoService("0123456789abcdef0123456789abcdef");
    private long nextPage = 10, nextFile = 100;
    private final UserKnowledgePageMapper pageMapper = proxy(UserKnowledgePageMapper.class, (method, args) -> {
        if (method.equals("selectList")) {
            var query = (com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper<?>) args[0];
            query.getSqlSegment();
            var values = query.getParamNameValuePairs().values();
            return pages.values().stream().filter(row -> values.contains(row.getUserId())).toList();
        }
        if (method.equals("insert")) {
            UserKnowledgePage row = (UserKnowledgePage) args[0]; row.setId(nextPage++); pages.put(row.getId(), row); return 1;
        }
        throw new UnsupportedOperationException(method);
    });
    private final KnowledgeAttachmentMapper fileMapper = proxy(KnowledgeAttachmentMapper.class, (method, args) -> {
        if (method.equals("insert")) {
            KnowledgeAttachment row = (KnowledgeAttachment) args[0]; row.setId(nextFile++); files.put(row.getId(), row); return 1;
        }
        if (method.equals("selectList")) {
            var query = (com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper<?>) args[0];
            query.getSqlSegment();
            var values = query.getParamNameValuePairs().values();
            return files.values().stream().filter(row -> values.contains(row.getUserId())).toList();
        }
        if (method.equals("selectOne")) {
            var query = (com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper<?>) args[0];
            query.getSqlSegment();
            var values = query.getParamNameValuePairs().values();
            return files.values().stream().filter(row -> values.contains(row.getId()) && values.contains(row.getUserId())).findFirst().orElse(null);
        }
        throw new UnsupportedOperationException(method);
    });
    private final KnowledgePageLinkMapper linkMapper = proxy(KnowledgePageLinkMapper.class, (method, args) -> {
        if (method.equals("insert")) { relationships.add((KnowledgePageLink) args[0]); return 1; }
        throw new UnsupportedOperationException(method);
    });
    private final KnowledgeOperationLogMapper logMapper = proxy(KnowledgeOperationLogMapper.class, (method, args) -> {
        if (method.equals("insert")) { operations.add((KnowledgeOperationLog) args[0]); return 1; }
        throw new UnsupportedOperationException(method);
    });
    private int treeLocks;
    private final SysUserMapper userMapper = proxy(SysUserMapper.class, (method, args) -> {
        if (method.equals("lockKnowledgeTreeOwner")) { treeLocks++; return args[0]; }
        throw new UnsupportedOperationException(method);
    });
    private final KnowledgeImageService images = new KnowledgeImageService(fileMapper, crypto);
    private final KnowledgeVaultService service = new KnowledgeVaultService(pageMapper, userMapper, linkMapper,
            logMapper, crypto, mock(RagIndexJobService.class), images);

    @BeforeEach void tableMetadata() {
        MapperBuilderAssistant assistant = new MapperBuilderAssistant(new MybatisConfiguration(), "vault-test");
        assistant.setCurrentNamespace("vault-test");
        TableInfoHelper.initTableInfo(assistant, UserKnowledgePage.class);
        TableInfoHelper.initTableInfo(assistant, KnowledgeAttachment.class);
    }

    @Test void previewIsReadOnlyAndConfirmationRestoresCollisionLinksImageWidthAndFiles() throws Exception {
        UserKnowledgePage existing = new UserKnowledgePage();
        existing.setId(1L); existing.setUserId(7L); existing.setTitle("阶段"); existing.setVersion(2);
        existing.setPageType("NOTE"); existing.setEncryptedContent(crypto.encrypt("old")); pages.put(1L, existing);
        byte[] png = KnowledgeImageServiceTest.raster("png");
        byte[] json = "{\"sample\":true}".getBytes(StandardCharsets.UTF_8);
        Map<String, byte[]> archive = new LinkedHashMap<>();
        archive.put("risk/阶段.md", "[[下一步#目标|看目标]]\n![[Pasted image 100.png|600]]\n[设置](设置.json)".getBytes(StandardCharsets.UTF_8));
        archive.put("risk/下一步.md", "# 目标\n后续".getBytes(StandardCharsets.UTF_8));
        archive.put("risk/Pasted image 100.png", png);
        archive.put("risk/设置.json", json);
        archive.put("risk/.obsidian/workspace.json", "{\"ignored\":true}".getBytes(StandardCharsets.UTF_8));
        MockMultipartFile upload = new MockMultipartFile("file", "risk.zip", "application/zip", KnowledgeVaultCodecTest.zipBytes(archive));
        Map<String, Object> preview = service.preview(7L, upload, null, null);
        assertEquals(2, preview.get("pageCount"));
        assertEquals(2, preview.get("attachmentCount"));
        assertEquals(1, preview.get("relationshipCount"));
        assertTrue(preview.toString().contains("阶段（导入"), preview.toString());
        assertEquals(1, pages.size(), "预览不写页面");
        assertTrue(files.isEmpty(), "预览不写附件");
        assertTrue(relationships.isEmpty(), "预览不写双链");
        assertTrue(operations.isEmpty(), "预览不写操作日志");
        assertEquals("old", crypto.decrypt(existing.getEncryptedContent()));

        var result = service.confirm(7L, upload, String.valueOf(preview.get("previewToken")), null, null);
        assertEquals(2, result.get("pageCount"));
        assertEquals(3, pages.size());
        assertEquals(2, files.size());
        assertEquals(1, relationships.size());
        assertEquals(1, operations.size());
        UserKnowledgePage stage = pages.values().stream().filter(p -> p.getTitle().startsWith("阶段（导入"))
                .findFirst().orElseThrow();
        String body = crypto.decrypt(stage.getEncryptedContent());
        assertTrue(body.contains("[[下一步#目标|看目标]]"));
        assertTrue(body.matches("(?s).*\\Q![[/api/knowledge/images/\\E[0-9]+\\Q|600]]\\E.*"));
        assertTrue(body.matches("(?s).*\\Q[设置](/api/knowledge/attachments/\\E[0-9]+\\Q)\\E.*"));
        assertEquals(pages.values().stream().filter(p -> p.getTitle().equals("下一步")).findFirst().orElseThrow().getId(),
                relationships.get(0).getTargetPageId());
        assertArrayEquals(png, images.readOwnedAttachment(7L, files.values().stream().filter(f -> f.getKind().equals("IMAGE")).findFirst().orElseThrow().getId()).bytes());
        assertArrayEquals(json, images.readOwnedAttachment(7L, files.values().stream().filter(f -> f.getKind().equals("FILE")).findFirst().orElseThrow().getId()).bytes());

        byte[] exported = service.export(7L, null);
        var decoded = new KnowledgeVaultCodec().decode(exported);
        assertEquals(3, decoded.notes().size());
        assertEquals(2, decoded.attachments().size());
        assertTrue(decoded.attachments().keySet().stream().anyMatch(path -> path.contains("Pasted image 100.png")));
        assertArrayEquals(png, decoded.attachments().values().stream().filter(value -> Arrays.equals(value, png)).findFirst().orElseThrow());
    }

    @Test void stalePreviewAndOtherUsersParentCannotImport() {
        MockMultipartFile zip = new MockMultipartFile("file", "vault.zip", "application/zip",
                KnowledgeVaultCodecTest.zip(Map.of("Note.md", "body")));
        String token = String.valueOf(service.preview(7L, zip, null, null).get("previewToken"));
        UserKnowledgePage conflict = new UserKnowledgePage();
        conflict.setId(1L); conflict.setUserId(7L); conflict.setTitle("Note"); conflict.setVersion(0); pages.put(1L, conflict);
        assertThrows(BusinessException.class, () -> service.confirm(7L, zip, token, null, null));
        assertEquals(1, pages.size());
        assertTrue(operations.isEmpty());
        assertThrows(BusinessException.class, () -> service.preview(8L, zip, 1L, 0));
    }

    @Test void invalidRasterFailsDuringReadOnlyPreviewRatherThanAfterConfirmation() {
        Map<String, byte[]> archive = new LinkedHashMap<>();
        archive.put("Note.md", "![[fake.png]]".getBytes(StandardCharsets.UTF_8));
        archive.put("fake.png", "not a PNG".getBytes(StandardCharsets.UTF_8));
        MockMultipartFile zip = new MockMultipartFile("file", "vault.zip", "application/zip",
                KnowledgeVaultCodecTest.zipBytes(archive));
        BusinessException failure = assertThrows(BusinessException.class,
                () -> service.preview(7L, zip, null, null));
        assertTrue(failure.getMessage().contains("fake.png"));
        assertTrue(pages.isEmpty());
        assertTrue(files.isEmpty());
        assertTrue(operations.isEmpty());
    }

    /**
     * 第七十四轮 review：每条链接原来都把全部笔记、全部附件的路径 fold 一遍、按几种写法各扫一遍，再按标题扫一遍 ——
     * 允许的上限（1000 页、两千个附件、两万条链接）一遍要五十多秒，确认导入时还要做两遍、持着目录锁。
     */
    @Test void linkResolutionAtTheAllowedLimitsIsFast() {
        Map<String, byte[]> archive = new LinkedHashMap<>();
        for (int f = 0; f < 1999; f++) archive.put("vault/assets/附件" + f + ".txt", ("f" + f).getBytes(StandardCharsets.UTF_8));
        int expected = 0;
        for (int d = 0; d < 50; d++) for (int n = 0; n < 19; n++) {
            int id = d * 19 + n;
            StringBuilder body = new StringBuilder("# 笔记" + id + "\n");
            for (int k = 0; k < 7; k++) { body.append("[[笔记").append((id * 7 + k * 131) % 950).append("]] "); expected++; }
            for (int k = 0; k < 7; k++) { body.append("[看](../目录").append((d + k) % 50).append("/笔记").append((d + k) % 50 * 19).append(".md) "); expected++; }
            for (int k = 0; k < 6; k++) body.append("![[附件").append((id * 6 + k) % 1999).append(".txt]] ");
            body.append("[[没有这一页").append(id).append("]]\n");
            archive.put("vault/目录" + d + "/笔记" + id + ".md", body.toString().getBytes(StandardCharsets.UTF_8));
        }
        MockMultipartFile zip = new MockMultipartFile("file", "big.zip", "application/zip", KnowledgeVaultCodecTest.zipBytes(archive));
        long started = System.nanoTime();
        Map<String, Object> preview = service.preview(7L, zip, null, null);
        long ms = (System.nanoTime() - started) / 1_000_000;
        assertEquals(1000, preview.get("pageCount"), "950 页笔记 + 50 个目录页");
        assertEquals(expected, preview.get("relationshipCount"), "双链和相对路径的笔记链接都要解析到（扫到了才算数）");
        assertEquals(950, preview.get("warningCount"), "每页一条找不到的");
        assertTrue(ms < 3000, "预览 1000 页、1999 个附件、19950 条链接用了 " + ms + "ms");
    }

    /** 第七十四轮 review：ZIP 本身的毛病（坏图、链接太多）在拿目录锁之前就报，不为它们锁住用户那一行 */
    @Test void problemsInTheZipItselfAreFoundBeforeTakingTheTreeLock() {
        Map<String, byte[]> badImage = new LinkedHashMap<>();
        badImage.put("Note.md", "![[fake.png]]".getBytes(StandardCharsets.UTF_8));
        badImage.put("fake.png", "not a PNG".getBytes(StandardCharsets.UTF_8));
        MockMultipartFile first = new MockMultipartFile("file", "a.zip", "application/zip", KnowledgeVaultCodecTest.zipBytes(badImage));
        assertThrows(BusinessException.class, () -> service.confirm(7L, first, "token", null, null));
        assertEquals(0, treeLocks, "坏图在锁里才报");

        MockMultipartFile second = new MockMultipartFile("file", "b.zip", "application/zip",
                KnowledgeVaultCodecTest.zip(Map.of("Note.md", "[[x]] ".repeat(20001))));
        BusinessException tooMany = assertThrows(BusinessException.class, () -> service.confirm(7L, second, "token", null, null));
        assertTrue(tooMany.getMessage().contains("20000"), tooMany.getMessage());
        assertEquals(0, treeLocks, "数链接在锁里才做");

        MockMultipartFile fine = new MockMultipartFile("file", "c.zip", "application/zip", KnowledgeVaultCodecTest.zip(Map.of("Note.md", "body")));
        service.confirm(7L, fine, String.valueOf(service.preview(7L, fine, null, null).get("previewToken")), null, null);
        assertEquals(1, treeLocks, "对照：正常的导入要拿锁");
    }

    @Test void exportRejectsAttachmentBudgetBeforeReadingBinaryRows() {
        KnowledgeImageService binary = mock(KnowledgeImageService.class);
        List<KnowledgeImageService.AttachmentRecord> metadata = new ArrayList<>();
        for (long id = 1; id <= 9; id++) {
            metadata.add(new KnowledgeImageService.AttachmentRecord(id, "image-" + id + ".png", "IMAGE",
                    "image/png", KnowledgeImageService.MAX_IMAGE_BYTES, 1, 1,
                    "/api/knowledge/images/" + id, null));
        }
        when(binary.listOwnedAttachments(7L)).thenReturn(metadata);
        when(binary.readOwnedAttachment(7L, 1L)).thenThrow(new BusinessException("不应读取附件二进制"));
        KnowledgeVaultService guarded = new KnowledgeVaultService(pageMapper, userMapper, linkMapper,
                logMapper, crypto, mock(RagIndexJobService.class), binary);

        BusinessException failure = assertThrows(BusinessException.class, () -> guarded.export(7L, null));
        assertEquals("导出内容超过 64 MiB，请选择较小的目录", failure.getMessage());
        verify(binary, never()).readOwnedAttachment(anyLong(), anyLong());
        assertTrue(operations.isEmpty());
    }

    @Test void noteAndNonImageEmbedsKeepTheirMeaningAndAnchorsAcrossImportExport() throws Exception {
        UserKnowledgePage existing = new UserKnowledgePage();
        existing.setId(1L); existing.setUserId(7L); existing.setTitle("测试用例"); existing.setPageType("NOTE");
        existing.setEncryptedContent(crypto.encrypt("existing")); pages.put(1L, existing);
        Map<String, byte[]> archive = new LinkedHashMap<>();
        archive.put("risk/入口.md", "![[测试用例#范围]]\n![[测试用例#^block]]\n![[assets/settings.json]]\n![[assets/report.pdf#page=2]]\n![声音](assets/voice.wav)\n`![[literal]]`".getBytes(StandardCharsets.UTF_8));
        archive.put("risk/测试用例.md", "# 范围\n测试说明 ^block".getBytes(StandardCharsets.UTF_8));
        archive.put("risk/assets/settings.json", "{\"enabled\":true}".getBytes(StandardCharsets.UTF_8));
        archive.put("risk/assets/report.pdf", "%PDF-1.7\n%%EOF".getBytes(StandardCharsets.US_ASCII));
        archive.put("risk/assets/voice.wav", "RIFFxxxxWAVEdata".getBytes(StandardCharsets.US_ASCII));
        MockMultipartFile zip = new MockMultipartFile("file", "risk.zip", "application/zip", KnowledgeVaultCodecTest.zipBytes(archive));
        Map<String, Object> preview = service.preview(7L, zip, null, null);
        assertEquals(2, preview.get("relationshipCount"), "笔记嵌入也是页面关系");
        assertFalse(preview.get("warnings").toString().contains("未解析"), "重名新增可提示，笔记和附件嵌入均应解析");
        service.confirm(7L, zip, String.valueOf(preview.get("previewToken")), null, null);
        UserKnowledgePage entry = pages.values().stream().filter(p -> p.getTitle().equals("入口")).findFirst().orElseThrow();
        String body = crypto.decrypt(entry.getEncryptedContent());
        assertTrue(body.contains("![[测试用例（导入 2）#范围]]"), body);
        assertTrue(body.contains("![[测试用例（导入 2）#^block]]"), body);
        assertTrue(body.contains("![[/api/knowledge/attachments/"), body);
        assertTrue(body.contains("#page=2]]"), body);
        assertTrue(body.contains("![声音](/api/knowledge/attachments/"), body);
        assertTrue(body.contains("`![[literal]]`"));
        assertEquals(1, relationships.size(), "重复嵌入只建一条图谱关系，附件不作为未找到笔记");
        assertNotNull(relationships.get(0).getTargetPageId());

        var exported = new KnowledgeVaultCodec().decode(service.export(7L, null));
        String restored = exported.notes().stream().filter(n -> n.title().equals("入口")).findFirst().orElseThrow().content();
        assertTrue(restored.contains("![[测试用例（导入 2）#范围|测试用例（导入 2）]]"), restored);
        assertTrue(restored.contains("![[assets/settings.json]]"), restored);
        assertTrue(restored.contains("![[assets/report.pdf#page=2]]"), restored);
        assertTrue(restored.contains("![声音](assets/voice.wav)"), restored);
    }

    interface Operation { Object run(String name, Object[] args); }
    @SuppressWarnings("unchecked")
    private static <T> T proxy(Class<T> type, Operation operation) {
        return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, (self, method, args) -> {
            if (method.getDeclaringClass() == Object.class) return method.getName().equals("toString") ? type.getSimpleName() : null;
            return operation.run(method.getName(), args);
        });
    }
}
