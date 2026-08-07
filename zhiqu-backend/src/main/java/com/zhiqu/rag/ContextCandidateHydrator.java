package com.zhiqu.rag;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.entity.AiNotebookSource;
import com.zhiqu.entity.AiSourceChunk;
import com.zhiqu.mapper.AiSourceChunkMapper;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

@Service
public class ContextCandidateHydrator {
    private final AiSourceChunkMapper chunkMapper;
    private final RagProperties properties;
    private final RagMetricsService metrics;

    public ContextCandidateHydrator(AiSourceChunkMapper chunkMapper,
                                    RagProperties properties,
                                    RagMetricsService metrics) {
        this.chunkMapper = chunkMapper;
        this.properties = properties;
        this.metrics = metrics;
    }

    public List<Map<String, Object>> hydrate(Long userId, Long notebookId,
                                             ScopeSelection scope,
                                             RagRetriever.RetrievalResult retrieval) {
        if (!retrieval.available() || retrieval.candidates().isEmpty()) return List.of();
        Map<Long, AiNotebookSource> allowedSources = new HashMap<>();
        for (AiNotebookSource source : scope.notebookSources()) {
            if (source.getUserId().equals(userId) && source.getNotebookId().equals(notebookId)
                    && "READY".equals(source.getStatus())) allowedSources.put(source.getId(), source);
        }
        Set<Long> chunkIds = new LinkedHashSet<>();
        retrieval.candidates().forEach(candidate -> {
            Long id = longValue(candidate.get("chunkId"));
            if (id != null) chunkIds.add(id);
        });
        if (chunkIds.isEmpty()) return List.of();
        Map<Long, AiSourceChunk> chunks = new HashMap<>();
        chunkMapper.selectBatchIds(chunkIds).forEach(chunk -> chunks.put(chunk.getId(), chunk));
        List<Map<String, Object>> rows = new ArrayList<>();
        for (Map<String, Object> candidate : retrieval.candidates()) {
            Long sourceId = longValue(candidate.get("sourceId"));
            Long chunkId = longValue(candidate.get("chunkId"));
            AiNotebookSource source = allowedSources.get(sourceId);
            AiSourceChunk chunk = chunks.get(chunkId);
            if (source == null || chunk == null || !sourceId.equals(chunk.getSourceId())) {
                metrics.recordCrossScopeDrop();
                continue;
            }
            int start = intValue(candidate.get("charStart"), 0);
            int end = intValue(candidate.get("charEnd"), start);
            Snippet snippet = snippet(chunk.getContent(), start, end);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("sourceId", source.getId());
            row.put("title", source.getTitle());
            row.put("sourceType", source.getSourceType());
            row.put("chunkIndex", chunk.getChunkIndex());
            row.put("content", snippet.content());
            row.put("_hitStart", snippet.hitStart());
            row.put("_hitEnd", snippet.hitEnd());
            row.put("retrievalMode", "VECTOR");
            row.put("distance", doubleValue(candidate.get("distance")));
            row.put("similarity", 1d - doubleValue(candidate.get("distance")));
            row.put("indexVersion", retrieval.generation().getIndexVersion());
            row.put("chunkId", chunk.getId());
            row.put("segmentIndex", intValue(candidate.get("segmentIndex"), 0));
            rows.add(row);
        }
        return rows;
    }

    private Snippet snippet(String raw, int hitStart, int hitEnd) {
        String content = raw == null ? "" : raw;
        int boundedStart = Math.max(0, Math.min(content.length(), hitStart));
        int boundedEnd = Math.max(boundedStart, Math.min(content.length(), hitEnd));
        if (content.length() <= properties.getMaxSnippetChars()) {
            return new Snippet(content, boundedStart, boundedEnd);
        }
        int center = Math.max(0, Math.min(content.length(), (boundedStart + boundedEnd) / 2));
        int start = Math.max(0, center - properties.getMaxSnippetChars() / 2);
        int end = Math.min(content.length(), start + properties.getMaxSnippetChars());
        start = Math.max(0, end - properties.getMaxSnippetChars());
        String prefix = start > 0 ? "…" : "";
        String suffix = end < content.length() ? "…" : "";
        String text = prefix + content.substring(start, end) + suffix;
        int relativeStart = Math.max(0, Math.min(text.length(), prefix.length() + boundedStart - start));
        int relativeEnd = Math.max(relativeStart,
                Math.min(text.length(), prefix.length() + boundedEnd - start));
        return new Snippet(text, relativeStart, relativeEnd);
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
