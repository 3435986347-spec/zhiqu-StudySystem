package com.zhiqu.service.impl;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.entity.AiNotebook;
import com.zhiqu.entity.AiNotebookSource;
import com.zhiqu.mapper.AiNotebookMapper;
import com.zhiqu.mapper.AiNotebookSourceMapper;
import com.zhiqu.mapper.AiSourceChunkMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.util.ReflectionTestUtils;

import java.lang.reflect.Constructor;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 图片原件没保存下来时，这份资料必须是 {@code ERROR}，不能是 {@code UPLOADED}。
 *
 * <p>由来（2026-09-23）：桌面版的上传目录解析到了只读的 {@code /private-uploads}，
 * 写原件每次都失败，而那段代码是 {@code catch (Exception ignored) {}}，之后照样把图片标成
 * {@code UPLOADED}。前端据此把它挂到下一条消息上，显示「图片已附到下一条消息」——
 * 库里 {@code file_path} 是 NULL，模型读不到，资料区下载是空的。一个<b>幽灵附件</b>。
 *
 * <p>图片和文本资料的区别是这条判据的全部理由：PDF 落盘失败时文本已经从上传流里抽出来了，
 * 问答照常可用；图片没有任何文本可回退，原件就是它的全部内容。
 *
 * <p>真跑 {@code uploadSource}，不扫源码。让写入失败的办法是把上传根目录放在
 * <b>一个普通文件下面</b> —— {@code createDirectories} 必然失败，跨平台稳定，不依赖权限位
 * （root 跑测试时 chmod 000 拦不住）。
 */
class AiSourceUploadStoreFailureTest {

    private static final byte[] PNG = {(byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0, 0, 0, 0};

    @TempDir
    Path tmp;

    @Test
    @DisplayName("图片原件写不进去 → ERROR 并说清原因，不得标成 UPLOADED")
    void 图片落盘失败必须是ERROR() throws Exception {
        Path blocker = Files.writeString(tmp.resolve("not-a-dir"), "x");
        Fixture f = new Fixture(blocker.resolve("private-uploads").toString());

        Map<String, Object> row = f.service.uploadSource(1L, 9L,
                new MockMultipartFile("file", "paste.png", "image/png", PNG));

        assertEquals("ERROR", row.get("status"),
                "图片原件没保存下来，却被标成 " + row.get("status") + "。前端会把它当成已附上的图片挂到消息上，"
                        + "模型读不到、下载也没有 —— 2026-09-23 的幽灵附件。");
        assertTrue(String.valueOf(row.get("parseError")).contains("原件保存失败"),
                "ERROR 没带原因：" + row.get("parseError") + "。只报失败不说为什么，"
                        + "用户分不清是「文件格式不对」还是「服务端存不下」。");
        assertEquals(false, row.get("hasFile"));
    }

    /** 正例：可写目录下照常是 UPLOADED，文件真的在盘上。没有它，上面那条改成「一律 ERROR」也能过。 */
    @Test
    @DisplayName("正例：目录可写时图片是 UPLOADED，原件真的落在 ai-sources/<userId>/ 下")
    void 可写时照常落盘() throws Exception {
        Fixture f = new Fixture(tmp.resolve("private-uploads").toString());

        Map<String, Object> row = f.service.uploadSource(1L, 9L,
                new MockMultipartFile("file", "paste.png", "image/png", PNG));

        assertEquals("UPLOADED", row.get("status"));
        assertEquals(true, row.get("hasFile"));
        Path userDir = tmp.resolve("private-uploads").resolve("ai-sources").resolve("1");
        try (Stream<Path> files = Files.list(userDir)) {
            assertTrue(files.anyMatch(p -> p.getFileName().toString().endsWith("paste.png")),
                    "UPLOADED 了，但 " + userDir + " 下没有原件");
        }
    }

    /** 文本资料落盘失败只是降级（下载回落为解析文本），问答照常 —— 不能被连带标成 ERROR。 */
    @Test
    @DisplayName("对照：文本资料落盘失败不算失败 —— 文本已抽出，问答照常可用")
    void 文本资料落盘失败只是降级() throws Exception {
        Path blocker = Files.writeString(tmp.resolve("not-a-dir"), "x");
        Fixture f = new Fixture(blocker.resolve("private-uploads").toString());

        Map<String, Object> row = f.service.uploadSource(1L, 9L,
                new MockMultipartFile("file", "note.txt", "text/plain", "二叉树的前序遍历".getBytes()));

        assertFalse("ERROR".equals(row.get("status")) && String.valueOf(row.get("parseError")).contains("原件保存失败"),
                "文本资料因为「原件没存下」被标成失败了。它的文本已经从上传流里抽出来，问答照常可用；"
                        + "这条规则只该落在图片上。实际：" + row);
    }

    /**
     * 挂了、但原件读不到的图，加载时要<b>留在列表里</b>（bytes 为空），不能 continue 掉。
     *
     * <p>下游 {@code ChatImageAttachments.build} 只能说出它收到了的东西。这里丢掉的话，
     * 模型对这张图一无所知 —— 旧代码的注释写着「build 会把少了几张说给模型」，
     * 而那恰恰做不到。库里的 6、7 两行（file_path 为 NULL 的图片）就是这个形状。
     */
    @Test
    @DisplayName("原件读不到的图，加载时要留在列表里交给下游说明，不能丢掉")
    void 读不到的图不能在加载处丢掉() throws Exception {
        Fixture f = new Fixture(tmp.resolve("private-uploads").toString());
        AiNotebookSource ghost = new AiNotebookSource();
        ghost.setId(6L);
        ghost.setUserId(1L);
        ghost.setNotebookId(9L);
        ghost.setSourceType("IMAGE");
        ghost.setTitle("粘贴的图片.png");
        ghost.setFilePath(null);
        when(f.sources.selectList(any())).thenReturn(java.util.List.of(ghost));

        var loaded = f.service.loadAttachedImages(1L, 9L, java.util.List.of(6L));

        assertEquals(1, loaded.size(),
                "file_path 为空的图在加载处被丢掉了 —— 模型不会知道用户挂过它，只会说「看不到图片」");
        assertEquals(6L, loaded.get(0).sourceId());
        assertTrue(loaded.get(0).bytes() == null || loaded.get(0).bytes().length == 0,
                "读不到的图不该带着字节");
    }

    /** 除了用到的几个 mapper，其余依赖一律空 mock —— 上传路径碰不到它们。 */
    private static final class Fixture {
        final AiWorkspaceServiceImpl service;
        final AiNotebookSourceMapper sources;

        Fixture(String privateUploadDir) throws Exception {
            Constructor<?> ctor = AiWorkspaceServiceImpl.class.getConstructors()[0];
            Object[] args = new Object[ctor.getParameterCount()];
            AiNotebookMapper notebooks = mock(AiNotebookMapper.class);
            sources = mock(AiNotebookSourceMapper.class);
            AiSourceChunkMapper chunks = mock(AiSourceChunkMapper.class);
            Class<?>[] types = ctor.getParameterTypes();
            for (int i = 0; i < types.length; i++) {
                if (types[i] == AiNotebookMapper.class) args[i] = notebooks;
                else if (types[i] == AiNotebookSourceMapper.class) args[i] = sources;
                else if (types[i] == AiSourceChunkMapper.class) args[i] = chunks;
                else if (types[i] == ObjectMapper.class) args[i] = new ObjectMapper();
                else args[i] = mock(types[i]);
            }

            AiNotebook notebook = new AiNotebook();
            notebook.setId(9L);
            notebook.setUserId(1L);
            when(notebooks.selectOne(any())).thenReturn(notebook);

            // 库就是一行：insert 给它发 id，之后的 updateById / selectById 都指向同一个对象。
            AtomicReference<AiNotebookSource> row = new AtomicReference<>();
            when(sources.insert(any(AiNotebookSource.class))).thenAnswer(inv -> {
                AiNotebookSource s = inv.getArgument(0);
                s.setId(42L);
                row.set(s);
                return 1;
            });
            when(sources.updateById(any(AiNotebookSource.class))).thenReturn(1);
            when(sources.selectById(any())).thenAnswer(inv -> row.get());
            when(chunks.selectCount(any())).thenReturn(0L);

            service = (AiWorkspaceServiceImpl) ctor.newInstance(args);
            ReflectionTestUtils.setField(service, "privateUploadDir", privateUploadDir);
        }
    }
}
