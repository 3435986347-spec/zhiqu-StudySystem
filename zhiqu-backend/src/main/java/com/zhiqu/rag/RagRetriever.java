package com.zhiqu.rag;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.zhiqu.entity.AiNotebookSource;
import com.zhiqu.entity.RagIndexGeneration;
import com.zhiqu.entity.RagSourceIndexState;
import com.zhiqu.mapper.RagIndexGenerationMapper;
import com.zhiqu.mapper.RagSourceIndexStateMapper;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

@Service
public class RagRetriever {
    private final RagProperties properties;
    private final RagClient client;
    private final RagIndexGenerationMapper generationMapper;
    private final RagSourceIndexStateMapper stateMapper;
    private final RagMetricsService metrics;

    public RagRetriever(RagProperties properties,
                        RagClient client,
                        RagIndexGenerationMapper generationMapper,
                        RagSourceIndexStateMapper stateMapper,
                        RagMetricsService metrics) {
        this.properties = properties;
        this.client = client;
        this.generationMapper = generationMapper;
        this.stateMapper = stateMapper;
        this.metrics = metrics;
    }

    /**
     * 检索。范围由 {@link ScopeSelection} 给出 —— {@code userId}/{@code notebookId} 仍单独传，
     * 因为它们是 sidecar 请求体的字段，与「范围里有哪些单元」是两件事。
     *
     * <p>1B-1 口径不变：仍只按 {@code sourceIds} 过滤，仍只查 NOTEBOOK_SOURCE 的索引状态。
     */
    public RetrievalResult retrieve(String requestId, Long userId, Long notebookId,
                                    ScopeSelection scope, String question) {
        // 两种不可用分开处理，而且**行为不同**，不只是文案不同：
        // DISABLED 是设计内的正常状态（仓库默认就是 false），记进 fallback 指标只会把它刷满、
        // 淹掉真正的回落原因；TOKEN_MISSING 是「开着却不工作」的配置错误，必须留下痕迹。
        String unavailable = client.unavailableReason();
        if (unavailable != null) {
            if (!RagClient.REASON_DISABLED.equals(unavailable)) metrics.recordFallback(unavailable);
            return RetrievalResult.unavailable(unavailable);
        }
        List<AiNotebookSource> sources = scope.notebookSources();
        RagIndexGeneration generation = generationMapper.selectOne(new LambdaQueryWrapper<RagIndexGeneration>()
                .eq(RagIndexGeneration::getStatus, "ACTIVE").orderByDesc(RagIndexGeneration::getId).last("LIMIT 1"));
        if (generation == null) {
            metrics.recordFallback("NO_ACTIVE_GENERATION");
            return RetrievalResult.unavailable("NO_ACTIVE_GENERATION");
        }
        List<Long> sourceIds = sources.stream().map(AiNotebookSource::getId).toList();
        List<RagSourceIndexState> states = sourceIds.isEmpty() ? List.of()
                : stateMapper.selectList(new LambdaQueryWrapper<RagSourceIndexState>()
                .eq(RagSourceIndexState::getGenerationId, generation.getId())
                .eq(RagSourceIndexState::getStatus, "INDEXED")
                .in(RagSourceIndexState::getSourceId, sourceIds));
        Map<Long, AiNotebookSource> byId = new LinkedHashMap<>();
        sources.forEach(source -> byId.put(source.getId(), source));
        Set<Long> indexed = new LinkedHashSet<>();
        for (RagSourceIndexState state : states) {
            AiNotebookSource source = byId.get(state.getSourceId());
            if (source != null && source.getContentHash() != null
                    && source.getContentHash().equals(state.getContentHash())) indexed.add(source.getId());
        }
        if (indexed.isEmpty()) {
            metrics.recordFallback("NO_INDEXED_SOURCE");
            return new RetrievalResult(false, "NO_INDEXED_SOURCE", generation, List.of(), Set.of());
        }
        long started = System.nanoTime();
        try {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("requestId", requestId);
            payload.put("userId", userId);
            payload.put("notebookId", notebookId);
            payload.put("question", question == null ? "" : question);
            payload.put("candidateK", properties.getCandidateK());
            payload.put("sourceIds", new ArrayList<>(indexed));
            payload.put("indexVersion", generation.getIndexVersion());
            payload.put("collectionName", generation.getCollectionName());
            Map<String, Object> response = client.query(payload);
            if (!generation.getIndexVersion().equals(String.valueOf(response.get("indexVersion")))) {
                metrics.recordFallback("INDEX_VERSION_MISMATCH");
                return RetrievalResult.unavailable("INDEX_VERSION_MISMATCH");
            }
            List<Map<String, Object>> candidates = mapList(response.get("candidates"));
            metrics.recordQuery((System.nanoTime() - started) / 1_000_000, candidates.size(), 0, 0);
            return new RetrievalResult(true, null, generation, candidates, indexed);
        } catch (Exception e) {
            String reason = e.getClass().getSimpleName();
            metrics.recordFallback(reason);
            return RetrievalResult.unavailable(reason);
        }
    }

    private List<Map<String, Object>> mapList(Object value) {
        if (!(value instanceof List<?> list)) return List.of();
        List<Map<String, Object>> rows = new ArrayList<>();
        for (Object item : list) {
            if (!(item instanceof Map<?, ?> source)) continue;
            Map<String, Object> row = new LinkedHashMap<>();
            source.forEach((key, entry) -> { if (key != null) row.put(String.valueOf(key), entry); });
            rows.add(row);
        }
        return rows;
    }

    public record RetrievalResult(boolean available, String fallbackReason, RagIndexGeneration generation,
                                  List<Map<String, Object>> candidates, Set<Long> indexedSourceIds) {
        static RetrievalResult unavailable(String reason) {
            return new RetrievalResult(false, reason, null, List.of(), Set.of());
        }
    }
}
