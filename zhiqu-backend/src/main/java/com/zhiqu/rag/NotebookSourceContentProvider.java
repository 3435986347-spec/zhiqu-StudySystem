package com.zhiqu.rag;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.entity.AiNotebookSource;
import com.zhiqu.entity.AiSourceChunk;
import com.zhiqu.entity.RagIndexableUnit;
import com.zhiqu.mapper.AiNotebookSourceMapper;
import com.zhiqu.mapper.AiSourceChunkMapper;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

/**
 * Notebook 资料的回读实现。
 *
 * <p>与 Wiki 实现的关键差异：<b>不重新分块</b>。父块边界直接沿用 {@code ai_source_chunk}，
 * 只把它们换算成规范化全文里的 code point 区间。重切会让每份存量资料的 content_hash
 * 全部变化并触发一次全量重建 —— 而 1B-1 声称自己是纯重构。
 */
@Component
public class NotebookSourceContentProvider implements UnitContentProvider {

    private final AiNotebookSourceMapper sourceMapper;
    private final AiSourceChunkMapper chunkMapper;

    public NotebookSourceContentProvider(AiNotebookSourceMapper sourceMapper, AiSourceChunkMapper chunkMapper) {
        this.sourceMapper = sourceMapper;
        this.chunkMapper = chunkMapper;
    }

    @Override
    public String namespace() {
        return RagNamespace.NOTEBOOK_SOURCE;
    }

    @Override
    public UnitContent load(RagIndexableUnit unit) {
        AiNotebookSource source = sourceMapper.selectOne(new LambdaQueryWrapper<AiNotebookSource>()
                .eq(AiNotebookSource::getId, unit.getRefId())
                .eq(AiNotebookSource::getUserId, unit.getUserId()));
        if (source == null) return UnitContent.gone("SOURCE_NOT_FOUND_OR_NOT_OWNED");

        // 解析中/解析失败的资料不是「没了」，是「现在没有可索引正文」——保留单元，等它 READY。
        if (!"READY".equals(source.getStatus())) return UnitContent.unusable("SOURCE_NOT_READY:" + source.getStatus());

        List<AiSourceChunk> chunks = chunkMapper.selectList(new LambdaQueryWrapper<AiSourceChunk>()
                .eq(AiSourceChunk::getSourceId, source.getId())
                .orderByAsc(AiSourceChunk::getChunkIndex));
        if (chunks.isEmpty()) return UnitContent.unusable("NO_PARENT_CHUNKS");

        List<String> texts = chunks.stream()
                .map(chunk -> chunk.getContent() == null ? "" : chunk.getContent())
                .toList();
        String canonical = CanonicalText.notebook(texts);
        if (canonical.isBlank()) return UnitContent.unusable("EMPTY_CONTENT");

        return UnitContent.ok(source.getTitle(), canonical, presetChunks(texts, canonical));
    }

    /**
     * 把父块换算成规范化全文里的 code point 区间。
     *
     * <p>拼接形态必须与 {@link CanonicalText#notebook} 逐字一致 —— 那边用
     * {@code CHUNK_SEPARATOR} 连接，这里就要按同一个分隔符的长度推进游标。
     *
     * <p><b>末尾那条断言今天恒真，这是有意保留的前向绊线，不是已生效的校验。</b>
     * 只要 {@code CanonicalText.notebook} 还是纯粹的 {@code String.join}，
     * {@code Σ len(texts) + (n−1)·len(sep) == len(join(sep, texts))} 就是算术恒等式
     * （分隔符非空，跨界拼不出新的代理对），没有任何输入能让它红。
     * 它防的是<b>将来</b>：谁给 {@code notebook()} 加一句 {@code strip()} 或清洗，
     * 偏移就会整体错位，而错位不抛异常、只会截出偏移几个字的内容。
     * 代价要说清楚——它是运行时断言，会在生产里炸，不会在 CI 里炸。
     */
    private List<RagUnitChunker.Chunk> presetChunks(List<String> texts, String canonical) {
        String separator = RagContentHashService.CHUNK_SEPARATOR;
        int separatorLength = separator.codePointCount(0, separator.length());

        List<RagUnitChunker.Chunk> result = new ArrayList<>(texts.size());
        int cursor = 0;
        for (int i = 0; i < texts.size(); i++) {
            String text = texts.get(i);
            int length = text.codePointCount(0, text.length());
            result.add(new RagUnitChunker.Chunk(i, cursor, cursor + length));
            cursor += length;
            if (i < texts.size() - 1) cursor += separatorLength;
        }

        int canonicalLength = canonical.codePointCount(0, canonical.length());
        if (cursor != canonicalLength) {
            throw new IllegalStateException("父块偏移与规范化全文长度不一致：" + cursor + " vs " + canonicalLength
                    + "，CanonicalText.notebook 的拼接形态与此处的推进方式已分叉");
        }
        return result;
    }
}
