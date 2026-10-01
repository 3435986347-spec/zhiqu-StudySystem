package com.zhiqu.rag;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.entity.AiNotebookSource;
import com.zhiqu.entity.AiSourceChunk;
import com.zhiqu.entity.RagIndexableUnit;
import com.zhiqu.entity.RagUnitChunk;
import com.zhiqu.mapper.AiSourceChunkMapper;
import com.zhiqu.mapper.RagUnitChunkMapper;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 把 sidecar 返回的候选回填成上下文行。
 *
 * <h2>step 3：按 {@code namespace} 分派，Wiki 走解密回读</h2>
 *
 * <p>两条命名空间的取正文方式<b>不同</b>，这是它们没有被合并成一个列表的原因
 * （见 {@code ScopeSelection.projectedUnits} 的注释）：
 * <ul>
 *   <li>{@code NOTEBOOK_SOURCE} —— 父块正文是明文，直接读 {@code ai_source_chunk.content}；</li>
 *   <li>{@code WIKI_PAGE} —— 正文是密文且<b>不落库</b>，要经 {@link UnitContentResolver}
 *       现取现解密，再按 {@code rag_unit_chunk} 的边界切出父块。</li>
 * </ul>
 *
 * <h2>偏移量的参照系（三层，错一层就静默错位）</h2>
 *
 * <ol>
 *   <li>{@code rag_unit_chunk.charStart/charEnd} —— 相对<b>单元的规范化全文</b>，单位 code point；</li>
 *   <li>候选的 {@code charStart/charEnd} —— 相对<b>父块正文</b>，单位 code point。
 *       sidecar 的 {@code segment_text} 是拿 {@code chunk["content"]} 调的
 *       （rag-service/app/vector_store.py:154），而 Python 的字符串下标就是 code point；</li>
 *   <li>片段裁剪的 {@code hitStart/hitEnd} —— 相对<b>返回的片段</b>。</li>
 * </ol>
 *
 * <p>三层都必须走 {@code RagUnitChunker.sliceByCodePoints}。用 {@code substring} 在
 * 全 BMP 的文本上完全正确，只在出现星平面字符（emoji、CJK 扩展 B）时错位，
 * 而且不抛异常 —— 表现是引用的正文偏了几个字。{@code OffsetParityTest} 守着这条。
 *
 * <h2>归属判据换成 {@code queriedUnits}</h2>
 *
 * <p>此前是拿 {@code AiNotebookSource} 逐个比对 {@code userId}/{@code notebookId}/{@code status}。
 * 那条判据只覆盖 Notebook 一个命名空间 —— Wiki 接进来之后它对 Wiki 候选<b>完全无话可说</b>，
 * 而认错的后果是把别人的内容喂进模型上下文。改成「候选的 {@code unitId} 必须在本次真正发出去的
 * {@code unitIds} 里」，一条判据覆盖全部命名空间，且与请求本身同源。
 */
@Service
public class ContextCandidateHydrator {

    /** 候选带的 unitId 不在本次请求的范围里 —— 越界，必须丢。 */
    static final String DROP_CROSS_SCOPE = "CROSS_SCOPE";
    /** 父块行找不到，或它属于另一个单元 —— 索引与库不同步。 */
    static final String DROP_STALE_CHUNK = "STALE_CHUNK";
    /** 候选缺 unitId / chunkId 这类必需字段。 */
    static final String DROP_MALFORMED = "MALFORMED_CANDIDATE";

    private final AiSourceChunkMapper chunkMapper;
    private final RagUnitChunkMapper unitChunkMapper;
    private final UnitContentResolver contentResolver;
    private final RagProperties properties;
    private final RagMetricsService metrics;

    public ContextCandidateHydrator(AiSourceChunkMapper chunkMapper,
                                    RagUnitChunkMapper unitChunkMapper,
                                    UnitContentResolver contentResolver,
                                    RagProperties properties,
                                    RagMetricsService metrics) {
        this.chunkMapper = chunkMapper;
        this.unitChunkMapper = unitChunkMapper;
        this.contentResolver = contentResolver;
        this.properties = properties;
        this.metrics = metrics;
    }

    public List<Map<String, Object>> hydrate(Long userId, Long notebookId,
                                             ScopeSelection scope,
                                             RagRetriever.RetrievalResult retrieval) {
        if (!retrieval.available() || retrieval.candidates().isEmpty()) return List.of();

        Map<Long, RagIndexableUnit> allowed = new LinkedHashMap<>();
        retrieval.queriedUnits().forEach(unit -> allowed.put(unit.getId(), unit));
        Map<Long, AiNotebookSource> sourcesByRefId = new HashMap<>();
        scope.notebookSources().forEach(source -> sourcesByRefId.put(source.getId(), source));

        // 一次问答里同一个单元通常命中多条候选。Wiki 的取正文要解密，
        // 不缓存的话每条候选解一次 —— 而这是同步的用户请求路径。
        Map<Long, UnitContent> contentCache = new HashMap<>();
        Map<Long, AiSourceChunk> notebookChunks = loadNotebookChunks(retrieval.candidates());
        Map<Long, RagUnitChunk> unitChunks = loadUnitChunks(retrieval.candidates());

        List<Map<String, Object>> rows = new ArrayList<>();
        for (Map<String, Object> candidate : retrieval.candidates()) {
            Long unitId = longValue(candidate.get("unitId"));
            Long chunkId = longValue(candidate.get("chunkId"));
            if (unitId == null || chunkId == null) {
                metrics.recordDroppedCandidate(text(candidate.get("namespace")), DROP_MALFORMED);
                continue;
            }
            RagIndexableUnit unit = allowed.get(unitId);
            if (unit == null) {
                metrics.recordDroppedCandidate(text(candidate.get("namespace")), DROP_CROSS_SCOPE);
                continue;
            }
            Map<String, Object> row = RagNamespace.WIKI_PAGE.equals(unit.getNamespace())
                    ? wikiRow(unit, candidate, chunkId, unitChunks, contentCache)
                    : notebookRow(unit, candidate, chunkId, notebookChunks, sourcesByRefId);
            if (row == null) continue;
            row.put("retrievalMode", "VECTOR");
            row.put("distance", doubleValue(candidate.get("distance")));
            row.put("similarity", 1d - doubleValue(candidate.get("distance")));
            row.put("indexVersion", retrieval.generation().getIndexVersion());
            row.put("segmentIndex", intValue(candidate.get("segmentIndex"), 0));
            rows.add(row);
        }
        return rows;
    }

    /**
     * Notebook 候选：父块正文是明文，直接取。
     *
     * <p>{@code chunk.sourceId} 必须等于 {@code unit.refId} —— 不等说明索引里的 chunkId
     * 指向了另一份资料的父块，是跨命名空间/跨资料撞车的形态，宁可丢掉也不能喂出去。
     */
    private Map<String, Object> notebookRow(RagIndexableUnit unit, Map<String, Object> candidate,
                                            Long chunkId, Map<Long, AiSourceChunk> chunks,
                                            Map<Long, AiNotebookSource> sourcesByRefId) {
        AiSourceChunk chunk = chunks.get(chunkId);
        AiNotebookSource source = sourcesByRefId.get(unit.getRefId());
        if (chunk == null || source == null || !unit.getRefId().equals(chunk.getSourceId())) {
            metrics.recordDroppedCandidate(unit.getNamespace(), DROP_STALE_CHUNK);
            return null;
        }
        Snippet snippet = snippet(chunk.getContent(),
                intValue(candidate.get("charStart"), 0), intValue(candidate.get("charEnd"), 0));
        Map<String, Object> row = new LinkedHashMap<>();
        row.put(CandidateKeys.SOURCE_ID, source.getId());
        row.put(CandidateKeys.TITLE, source.getTitle());
        row.put(CandidateKeys.SOURCE_TYPE, source.getSourceType());
        row.put(CandidateKeys.CHUNK_INDEX, chunk.getChunkIndex());
        row.put(CandidateKeys.CONTENT, snippet.content());
        row.put(CandidateKeys.HIT_START, snippet.hitStart());
        row.put(CandidateKeys.HIT_END, snippet.hitEnd());
        row.put(CandidateKeys.CHUNK_ID, chunk.getId());
        return row;
    }

    /**
     * Wiki 候选：正文要现取现解密，再按父块边界切出来。
     *
     * <p><b>回读失败只丢这一条候选，整次检索仍算成功</b>（方案 1：单独计数）。
     * 降级成整次回落的话，一页坏密文会让所有检索退化成关键词 ——
     * 一个局部故障放大成全局降级。丢掉的那条记进
     * {@code recordDroppedCandidate(namespace, reason)}，粒度与失败的粒度一致。
     *
     * <p><b>{@code sourceId} 必须经 {@link CandidateKeys#wikiSourceId}</b>，
     * 与 {@code wikiContext} 同源 —— 承重的是两个生产者之间一致，不是形状本身。
     * 两者永久并存（E-3 决定保留直读保底），所以这条一致性不是过渡期约定，
     * 而是靠「前缀字面量全仓只有一处」变成写不出来的错误。
     */
    private Map<String, Object> wikiRow(RagIndexableUnit unit, Map<String, Object> candidate,
                                        Long chunkId, Map<Long, RagUnitChunk> unitChunks,
                                        Map<Long, UnitContent> contentCache) {
        RagUnitChunk chunk = unitChunks.get(chunkId);
        if (chunk == null || !unit.getId().equals(chunk.getUnitId())) {
            metrics.recordDroppedCandidate(unit.getNamespace(), DROP_STALE_CHUNK);
            return null;
        }
        UnitContent content = contentCache.computeIfAbsent(unit.getId(),
                ignored -> contentResolver.load(unit));
        if (content.outcome() != UnitContent.Outcome.OK) {
            // reason 里只有原因码（DECRYPT_FAILED / PAGE_NOT_FOUND_OR_NOT_OWNED…），没有正文片段。
            // 硬约束见 RagMetricsService.recordDroppedCandidate：只记 unitId 与原因，绝不记内容。
            metrics.recordDroppedCandidate(unit.getNamespace(), content.reason());
            return null;
        }
        String parent = RagUnitChunker.sliceByCodePoints(content.canonicalText(),
                chunk.getCharStart() == null ? 0 : chunk.getCharStart(),
                chunk.getCharEnd() == null ? 0 : chunk.getCharEnd());
        Snippet snippet = snippet(parent,
                intValue(candidate.get("charStart"), 0), intValue(candidate.get("charEnd"), 0));
        Map<String, Object> row = new LinkedHashMap<>();
        row.put(CandidateKeys.SOURCE_ID, CandidateKeys.wikiSourceId(unit.getRefId()));
        row.put(CandidateKeys.TITLE, content.title() == null ? unit.getTitle() : content.title());
        row.put(CandidateKeys.SOURCE_TYPE, RagNamespace.WIKI_PAGE);
        row.put(CandidateKeys.CHUNK_INDEX, chunk.getChunkIndex());
        row.put(CandidateKeys.CONTENT, snippet.content());
        row.put(CandidateKeys.HIT_START, snippet.hitStart());
        row.put(CandidateKeys.HIT_END, snippet.hitEnd());
        row.put(CandidateKeys.CHUNK_ID, chunk.getId());
        return row;
    }

    private Map<Long, AiSourceChunk> loadNotebookChunks(List<Map<String, Object>> candidates) {
        Set<Long> ids = chunkIdsOf(candidates);
        Map<Long, AiSourceChunk> byId = new HashMap<>();
        if (ids.isEmpty()) return byId;
        chunkMapper.selectBatchIds(ids).forEach(chunk -> byId.put(chunk.getId(), chunk));
        return byId;
    }

    private Map<Long, RagUnitChunk> loadUnitChunks(List<Map<String, Object>> candidates) {
        Set<Long> ids = chunkIdsOf(candidates);
        Map<Long, RagUnitChunk> byId = new HashMap<>();
        if (ids.isEmpty()) return byId;
        unitChunkMapper.selectList(new LambdaQueryWrapper<RagUnitChunk>()
                .in(RagUnitChunk::getId, ids)).forEach(chunk -> byId.put(chunk.getId(), chunk));
        return byId;
    }

    /**
     * 两张表都按候选里的 {@code chunkId} 取，<b>而两张表的 id 空间是独立的</b>。
     *
     * <p>所以取回来之后必须再验一次归属（{@code chunk.sourceId == unit.refId} /
     * {@code chunk.unitId == unit.id}）：一个 {@code ai_source_chunk} 的 id 完全可能
     * 等于某个 {@code rag_unit_chunk} 的 id，光按 id 取会取到毫不相干的一行。
     */
    private Set<Long> chunkIdsOf(List<Map<String, Object>> candidates) {
        Set<Long> ids = new LinkedHashSet<>();
        candidates.forEach(candidate -> {
            Long id = longValue(candidate.get("chunkId"));
            if (id != null) ids.add(id);
        });
        return ids;
    }

    /**
     * 按 code point 裁剪片段，并把命中区间换算到片段内的坐标。
     *
     * <p>入参 {@code hitStart}/{@code hitEnd} 是<b>父块内</b>的 code point 下标，
     * 返回的 {@code hitStart}/{@code hitEnd} 是<b>片段内</b>的 code point 下标。
     */
    private Snippet snippet(String raw, int hitStart, int hitEnd) {
        String content = raw == null ? "" : raw;
        int total = content.codePointCount(0, content.length());
        int boundedStart = Math.max(0, Math.min(total, hitStart));
        int boundedEnd = Math.max(boundedStart, Math.min(total, hitEnd));
        int budget = properties.getMaxSnippetChars();
        if (total <= budget) return new Snippet(content, boundedStart, boundedEnd);
        int center = (boundedStart + boundedEnd) / 2;
        int start = Math.max(0, center - budget / 2);
        int end = Math.min(total, start + budget);
        start = Math.max(0, end - budget);
        String prefix = start > 0 ? "…" : "";
        String suffix = end < total ? "…" : "";
        String text = prefix + RagUnitChunker.sliceByCodePoints(content, start, end) + suffix;
        int textTotal = text.codePointCount(0, text.length());
        int relativeStart = Math.max(0, Math.min(textTotal, prefix.length() + boundedStart - start));
        int relativeEnd = Math.max(relativeStart, Math.min(textTotal, prefix.length() + boundedEnd - start));
        return new Snippet(text, relativeStart, relativeEnd);
    }

    private String text(Object value) {
        return value == null ? null : String.valueOf(value);
    }

    private Long longValue(Object value) {
        if (value instanceof Number number) return number.longValue();
        try { return Long.parseLong(String.valueOf(value)); } catch (Exception ignored) { return null; }
    }

    private int intValue(Object value, int fallback) {
        if (value instanceof Number number) return number.intValue();
        try { return Integer.parseInt(String.valueOf(value)); } catch (Exception ignored) { return fallback; }
    }

    private double doubleValue(Object value) {
        if (value instanceof Number number) return number.doubleValue();
        try { return Double.parseDouble(String.valueOf(value)); } catch (Exception ignored) { return 1d; }
    }

    private record Snippet(String content, int hitStart, int hitEnd) {}
}
