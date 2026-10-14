package com.zhiqu.service.knowledge;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.common.Result;
import com.zhiqu.controller.KnowledgeAttachmentController;
import com.zhiqu.entity.KnowledgeAttachment;
import com.zhiqu.mapper.KnowledgeAttachmentMapper;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

/** Preview uses real crypto and synthetic bytes, never a real vault or browser-executable text. */
class KnowledgeAttachmentPreviewTest {
    private final KnowledgeAttachmentMapper mapper = mock(KnowledgeAttachmentMapper.class);
    private final SensitiveCryptoService crypto = new SensitiveCryptoService("0123456789abcdef0123456789abcdef");
    private final KnowledgeImageService service = new KnowledgeImageService(mapper, crypto);

    @BeforeEach void setup() {
        MapperBuilderAssistant assistant = new MapperBuilderAssistant(new MybatisConfiguration(), "preview-test");
        assistant.setCurrentNamespace("preview-test");
        TableInfoHelper.initTableInfo(assistant, KnowledgeAttachment.class);
    }
    @AfterEach void clearAuthentication() { SecurityContextHolder.clearContext(); }

    @Test void ownedJsonAndCanvasPreviewExposeTextInsteadOfAnImagePlaceholder() {
        Map<String, Object> json = preview("settings.json", "{\"enabled\":true}".getBytes(StandardCharsets.UTF_8));
        assertEquals("JSON", json.get("previewType"));
        assertEquals("application/json", json.get("mimeType"));
        assertEquals("{\"enabled\":true}", json.get("text"));
        assertEquals(false, json.get("truncated"));
        assertEquals("CANVAS", preview("map.canvas", "{\"nodes\":[],\"edges\":[]}".getBytes(StandardCharsets.UTF_8)).get("previewType"));
        for (String canvas : new String[] { "{}", "{\"nodes\":[]}", "{\"edges\":[]}" }) {
            assertEquals("CANVAS", preview("empty.canvas", canvas.getBytes(StandardCharsets.UTF_8)).get("previewType"),
                    "JSON Canvas 1.0 允许缺省 nodes 和 edges：" + canvas);
        }
    }

    @Test void malformedJsonAndActiveDocumentsStayEscapedTextWithoutExecuting() {
        assertEquals("TEXT", preview("broken.json", "{broken".getBytes(StandardCharsets.UTF_8)).get("previewType"));
        for (String extension : new String[] { "html", "js", "svg" }) {
            String text = "<script>alert('private')</script>";
            Map<String, Object> source = preview("source." + extension, text.getBytes(StandardCharsets.UTF_8));
            assertEquals("TEXT", source.get("previewType"));
            assertEquals("text/plain", source.get("mimeType"));
            assertEquals(text, source.get("text"));
        }
        assertEquals("FILE", preview("binary.txt", new byte[] { (byte) 0xc3, (byte) 0x28 }).get("previewType"));
        assertEquals("FILE", preview("binary.json", new byte[] { 0, 1, 2 }).get("previewType"));
    }

    @Test void textPreviewIsBoundedAtUtf8BoundaryAndReportsTruncation() {
        String input = "x".repeat(512 * 1024 - 1) + "中文";
        Map<String, Object> data = preview("large.txt", input.getBytes(StandardCharsets.UTF_8));
        assertEquals("TEXT", data.get("previewType"));
        assertEquals(true, data.get("truncated"));
        String text = (String) data.get("text");
        assertTrue(text.getBytes(StandardCharsets.UTF_8).length <= 512 * 1024);
        assertFalse(text.contains("\ufffd"));
        assertTrue(input.startsWith(text));
    }

    @Test void safeBinaryTypesRequireTheirActualSignatureAndUnsupportedFilesRemainNamed() {
        assertEquals("PDF", preview("report.pdf", "%PDF-1.7\n%%EOF".getBytes(StandardCharsets.US_ASCII)).get("previewType"));
        assertEquals("AUDIO", preview("voice.mp3", new byte[] { 'I', 'D', '3', 4, 0, 0, 0, 0, 0, 0 }).get("previewType"));
        assertEquals("VIDEO", preview("clip.webm", new byte[] { 0x1a, 0x45, (byte) 0xdf, (byte) 0xa3, 0, 0, 0, 0 }).get("previewType"));
        for (String name : new String[] { "fake.pdf", "fake.mp3", "fake.mp4", "file.docx", "image.avif" }) {
            Map<String, Object> file = preview(name, "<html>not media</html>".getBytes(StandardCharsets.UTF_8));
            assertEquals("FILE", file.get("previewType"), name);
            assertEquals(name, file.get("name"));
            assertFalse(file.containsKey("text"));
        }
    }

    @Test void controllerPreviewRequiresCurrentOwnerAndReturnsNoForeignText() throws Exception {
        row("settings.json", "{\"private\":true}".getBytes(StandardCharsets.UTF_8));
        Method preview = method(KnowledgeAttachmentController.class, "preview", Long.class);
        assertThrows(BusinessException.class, () -> invoke(preview, new KnowledgeAttachmentController(service), 101L));
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(22L, "unused"));
        assertThrows(BusinessException.class, () -> invoke(preview, new KnowledgeAttachmentController(service), 101L));
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(11L, "unused"));
        Object response = invoke(preview, new KnowledgeAttachmentController(service), 101L);
        assertInstanceOf(Result.class, response);
        assertEquals(200, ((Result<?>) response).getCode());
        assertEquals("JSON", ((Map<?, ?>) ((Result<?>) response).getData()).get("previewType"));
    }

    @Test void bmpContentCanBeReadAsAnImageRatherThanAnOpaqueMissingFile() throws Exception {
        byte[] bytes = KnowledgeImageServiceTest.raster("bmp");
        when(mapper.insert(any(KnowledgeAttachment.class))).thenAnswer(call -> {
            ((KnowledgeAttachment) call.getArgument(0)).setId(101L); return 1;
        });
        var record = service.storeOwnedAttachment(11L, "diagram.bmp", bytes, "diagram.bmp");
        assertEquals("IMAGE", record.kind());
        assertEquals("image/bmp", record.mimeType());
        assertEquals(3, record.width());
    }

    @SuppressWarnings("unchecked") private Map<String, Object> preview(String name, byte[] bytes) {
        row(name, bytes);
        return (Map<String, Object>) invoke(method(KnowledgeImageService.class, "previewOwnedAttachment", Long.class, Long.class), service, 11L, 101L);
    }
    private void row(String name, byte[] bytes) {
        KnowledgeAttachment row = new KnowledgeAttachment(); row.setId(101L); row.setUserId(11L);
        row.setName(name); row.setKind("FILE"); row.setMimeType("application/octet-stream"); row.setByteSize((long) bytes.length);
        row.setEncryptedData(crypto.encrypt("base64:" + Base64.getEncoder().encodeToString(bytes)));
        when(mapper.selectOne(any())).thenReturn(row);
    }
    private static Method method(Class<?> type, String name, Class<?>... arguments) {
        Method found = java.util.Arrays.stream(type.getMethods()).filter(m -> m.getName().equals(name)
                && java.util.Arrays.equals(m.getParameterTypes(), arguments)).findFirst().orElse(null);
        assertNotNull(found, "真实附件预览 API 尚不存在");
        return found;
    }
    private static Object invoke(Method method, Object instance, Object... arguments) {
        try { return method.invoke(instance, arguments); }
        catch (InvocationTargetException e) {
            if (e.getCause() instanceof RuntimeException runtime) throw runtime;
            throw new AssertionError(e.getCause());
        } catch (ReflectiveOperationException e) { throw new AssertionError(e); }
    }
}
