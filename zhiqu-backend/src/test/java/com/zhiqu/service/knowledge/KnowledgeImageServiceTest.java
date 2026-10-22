package com.zhiqu.service.knowledge;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.controller.KnowledgeAttachmentController;
import com.zhiqu.controller.KnowledgeImageController;
import com.zhiqu.entity.KnowledgeAttachment;
import com.zhiqu.mapper.KnowledgeAttachmentMapper;
import com.zhiqu.service.privacy.CryptoKeyRotation;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/** Real crypto, real image bytes and a query-aware in-memory mapper; no app/DB or user files. */
class KnowledgeImageServiceTest {
    private final Map<Long, KnowledgeAttachment> rows = new LinkedHashMap<>();
    private final SensitiveCryptoService crypto = new SensitiveCryptoService("0123456789abcdef0123456789abcdef");
    private LambdaQueryWrapper<KnowledgeAttachment> lastQuery;
    private boolean returnForeignRow;
    private long nextId = 101L;
    private final KnowledgeAttachmentMapper mapper = (KnowledgeAttachmentMapper) Proxy.newProxyInstance(
            KnowledgeAttachmentMapper.class.getClassLoader(), new Class<?>[] { KnowledgeAttachmentMapper.class },
            (proxy, method, args) -> {
                if (method.getName().equals("insert")) {
                    KnowledgeAttachment row = (KnowledgeAttachment) args[0];
                    row.setId(nextId++);
                    rows.put(row.getId(), row);
                    return 1;
                }
                if (method.getName().equals("selectOne") || method.getName().equals("selectList")) {
                    @SuppressWarnings("unchecked")
                    LambdaQueryWrapper<KnowledgeAttachment> query = (LambdaQueryWrapper<KnowledgeAttachment>) args[0];
                    lastQuery = query;
                    String sql = query.getSqlSegment();
                    var values = query.getParamNameValuePairs().values();
                    List<KnowledgeAttachment> found = new ArrayList<>();
                    for (KnowledgeAttachment row : rows.values()) {
                        if (returnForeignRow || ((!sql.contains("user_id =") || values.contains(row.getUserId()))
                                && (!sql.contains("id =") || values.contains(row.getId()) || sql.contains("user_id =") && !sql.contains(" AND id ="))
                                && (!sql.contains("kind =") || values.contains(row.getKind())))) found.add(row);
                    }
                    return method.getName().equals("selectOne") ? found.isEmpty() ? null : found.get(0) : found;
                }
                if (method.getName().equals("toString")) return "memory-attachment-mapper";
                throw new UnsupportedOperationException(method.toString());
            });
    private final KnowledgeImageService service = new KnowledgeImageService(mapper, crypto);

    @BeforeEach
    void setup() {
        MapperBuilderAssistant assistant = new MapperBuilderAssistant(new MybatisConfiguration(), "image-test");
        assistant.setCurrentNamespace("image-test");
        TableInfoHelper.initTableInfo(assistant, KnowledgeAttachment.class);
    }

    @AfterEach
    void clearAuthentication() { SecurityContextHolder.clearContext(); }

    @Test
    void storesEncryptedImageAndExportsExactOriginalBytes() throws Exception {
        byte[] bytes = raster("png");
        var image = service.storeOwnedImage(11L, "../../截图.png", bytes);
        KnowledgeAttachment row = rows.get(image.id());
        assertTrue(crypto.isEncrypted(row.getEncryptedData()));
        assertFalse(row.getEncryptedData().contains(Base64.getEncoder().encodeToString(bytes)));
        assertEquals("截图.png", image.name());
        assertEquals("image/png", image.mimeType());
        assertEquals(3, image.width());
        assertEquals(2, image.height());
        assertEquals("/api/knowledge/images/" + image.id(), image.url());
        assertArrayEquals(bytes, service.readOwnedImage(11L, image.id()).bytes());
        assertArrayEquals(bytes, service.readOwnedAttachment(11L, image.id()).bytes());
        assertTrue(lastQuery.getSqlSegment().contains("user_id ="));
        assertTrue(lastQuery.getSqlSegment().contains("id ="));
        assertTrue(CryptoKeyRotation.TABLES.stream().anyMatch(spec -> spec.table().equals("knowledge_attachment")
                && spec.encryptedColumns().contains("encrypted_data")));
    }

    @Test
    void opaqueJsonAndEmptyFilesRoundTripWithoutBecomingAnImage() {
        byte[] json = "{\"test_setting\":true}".getBytes(StandardCharsets.UTF_8);
        var file = service.storeOwnedAttachment(11L, "状态.json", json, "设置/状态.json");
        assertEquals("FILE", file.kind());
        assertEquals("application/octet-stream", file.mimeType());
        assertNull(file.width());
        assertEquals("设置/状态.json", file.originalPath());
        assertEquals("/api/knowledge/attachments/" + file.id(), file.url());
        assertTrue(crypto.isEncrypted(rows.get(file.id()).getEncryptedData()));
        assertArrayEquals(json, service.readOwnedAttachment(11L, file.id()).bytes());
        assertThrows(BusinessException.class, () -> service.readOwnedImage(11L, file.id()));
        var empty = service.storeOwnedAttachment(11L, "empty.txt", new byte[0], "empty.txt");
        assertArrayEquals(new byte[0], service.readOwnedAttachment(11L, empty.id()).bytes());
    }

    @Test
    void importedImagePreservesOriginalVaultPathAndBytes() throws Exception {
        byte[] bytes = raster("gif");
        var image = service.storeOwnedAttachment(11L, "动图.gif", bytes, "附件/动图.gif");
        assertEquals("IMAGE", image.kind());
        assertEquals("image/gif", image.mimeType());
        assertEquals("附件/动图.gif", image.originalPath());
        assertArrayEquals(bytes, service.readOwnedImage(11L, image.id()).bytes());
    }

    @Test
    void longImportedImageNameKeepsItsExtensionAndImageKind() throws Exception {
        String name = "x".repeat(190) + ".png";
        var image = service.storeOwnedAttachment(11L, name, raster("png"), name);
        assertEquals("IMAGE", image.kind());
        assertTrue(image.name().endsWith(".png"));
        assertTrue(image.name().codePointCount(0, image.name().length()) <= 180);
        assertEquals(name, image.originalPath());
    }

    @Test
    void refusesAnotherOwnersBytesAndMetadataEvenIfMapperReturnsForeignRow() throws Exception {
        var own = service.storeOwnedImage(11L, "private.png", raster("png"));
        BusinessException denial = assertThrows(BusinessException.class, () -> service.readOwnedImage(22L, own.id()));
        assertEquals("图片不存在或无权访问", denial.getMessage());
        assertTrue(lastQuery.getSqlSegment().contains("user_id ="));
        assertTrue(lastQuery.getParamNameValuePairs().containsValue(22L));
        assertTrue(service.listOwnedAttachments(22L).isEmpty());
        returnForeignRow = true;
        assertThrows(BusinessException.class, () -> service.readOwnedAttachment(22L, own.id()));
    }

    @Test
    void listsOnlyOwnedMetadataWithoutFetchingEncryptedColumn() throws Exception {
        service.storeOwnedImage(11L, "mine.png", raster("png"));
        service.storeOwnedAttachment(11L, "note.json", new byte[] { 1 }, "note.json");
        service.storeOwnedImage(22L, "theirs.png", raster("png"));
        assertEquals(2, service.listOwnedAttachments(11L).size());
        assertFalse(lastQuery.getSqlSelect().contains("encrypted_data"));
        assertTrue(lastQuery.getSqlSegment().contains("user_id ="));
        assertEquals(1, service.listOwnedImages(11L).size());
        assertTrue(lastQuery.getSqlSegment().contains("kind ="));
    }

    @Test
    void attachmentListControllerUsesCurrentOwnerAndNeverReadsEncryptedBytes() throws Exception {
        var own = service.storeOwnedAttachment(11L, "settings.json", "{\"enabled\":true}".getBytes(StandardCharsets.UTF_8), "assets/settings.json");
        service.storeOwnedAttachment(22L, "private.json", "{\"private\":true}".getBytes(StandardCharsets.UTF_8), "private.json");
        KnowledgeAttachmentController controller = new KnowledgeAttachmentController(service);
        assertThrows(BusinessException.class, controller::list);
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(11L, "unused"));
        var response = controller.list();
        assertEquals(200, response.getCode());
        assertEquals(List.of(own.id()), response.getData().stream().map(KnowledgeImageService.AttachmentRecord::id).toList());
        assertEquals("assets/settings.json", response.getData().get(0).originalPath());
        assertTrue(lastQuery.getSqlSegment().contains("user_id ="));
        assertTrue(lastQuery.getParamNameValuePairs().containsValue(11L));
        assertFalse(lastQuery.getSqlSelect().contains("encrypted_data"));
    }

    @Test
    void rejectsSvgFakeRasterTraversalAndUnauthenticatedWrites() throws Exception {
        byte[] svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>".getBytes(StandardCharsets.UTF_8);
        assertThrows(BusinessException.class, () -> service.storeOwnedImage(11L, "unsafe.png", svg));
        assertThrows(BusinessException.class, () -> service.storeOwnedAttachment(11L, "fake.jpg", svg, "fake.jpg"));
        byte[] valid = raster("png");
        assertThrows(BusinessException.class, () -> service.storeOwnedImage(null, "image.png", valid));
        assertThrows(BusinessException.class, () -> service.storeOwnedAttachment(0L, "a.json", new byte[0], "a.json"));
        for (String path : List.of("../a.json", "/a.json", "C:/a.json", "a//b.json", "a/./b.json", "a\u0000.json")) {
            assertThrows(BusinessException.class, () -> service.storeOwnedAttachment(11L, "a.json", new byte[0], path), path);
        }
        assertTrue(rows.isEmpty());
    }

    @Test
    void escapedMarkdownNameCannotInjectAnotherLink() throws Exception {
        var image = service.storeOwnedImage(11L, "x](javascript:test)[y.png", raster("png"));
        String markdown = String.valueOf(image.asMap().get("markdown"));
        assertTrue(markdown.startsWith("![x\\](javascript:test)\\[y.png]"));
        assertTrue(markdown.endsWith("(/api/knowledge/images/" + image.id() + ")"));
    }

    @Test
    void detectsRealContentDespiteSpoofedUploadMimeAndProtectsReadHeaders() throws Exception {
        byte[] bytes = raster("png");
        var image = service.uploadOwnedImage(11L, new MockMultipartFile("file", "renamed.jpg", "text/html", bytes));
        assertEquals("image/png", image.mimeType());
        assertEquals("renamed.png", image.name());
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(11L, "unused"));
        var response = new KnowledgeImageController(service).image(image.id());
        assertEquals(MediaType.IMAGE_PNG, response.getHeaders().getContentType());
        assertEquals("private, no-store", response.getHeaders().getFirst(HttpHeaders.CACHE_CONTROL));
        assertEquals("nosniff", response.getHeaders().getFirst("X-Content-Type-Options"));
        assertTrue(response.getHeaders().getFirst(HttpHeaders.CONTENT_DISPOSITION).startsWith("inline;"));
        assertArrayEquals(bytes, response.getBody());
        SecurityContextHolder.clearContext();
        assertThrows(BusinessException.class, () -> new KnowledgeImageController(service).image(image.id()));
    }

    @Test
    void svgAndHtmlFromVaultAreForcedPrivateDownloads() {
        byte[] html = "<html><script>alert(1)</script></html>".getBytes(StandardCharsets.UTF_8);
        var file = service.storeOwnedAttachment(11L, "unsafe.html", html, "unsafe.html");
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(11L, "unused"));
        var response = new KnowledgeAttachmentController(service).attachment(file.id());
        assertEquals(MediaType.APPLICATION_OCTET_STREAM, response.getHeaders().getContentType());
        assertTrue(response.getHeaders().getFirst(HttpHeaders.CONTENT_DISPOSITION).startsWith("attachment;"));
        assertEquals("nosniff", response.getHeaders().getFirst("X-Content-Type-Options"));
        assertEquals("private, no-store", response.getHeaders().getFirst(HttpHeaders.CACHE_CONTROL));
        assertArrayEquals(html, response.getBody());
    }

    @Test
    void byteArrayAccessCannotMutateStoredOrPreviouslyReadBytes() throws Exception {
        byte[] bytes = raster("png");
        var record = service.storeOwnedImage(11L, "test.png", bytes);
        var data = service.readOwnedImage(11L, record.id());
        byte[] changed = data.bytes();
        changed[0] = 0;
        assertArrayEquals(bytes, data.bytes());
        assertArrayEquals(bytes, service.readOwnedImage(11L, record.id()).bytes());
    }

    static byte[] raster(String type) throws Exception {
        BufferedImage image = new BufferedImage(3, 2, BufferedImage.TYPE_INT_RGB);
        image.setRGB(1, 1, 0x123456);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        assertTrue(ImageIO.write(image, type, output));
        return output.toByteArray();
    }
}
