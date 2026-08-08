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
        if (RagClient.REASON_DISABLED.equals(unavailable)) return disabled();
        if (unavailable != null) return fallback(unavailable);
        List<AiNotebookSource> sources = scope.notebookSources();
        RagIndexGeneration generation = generationMapper.selectOne(new LambdaQueryWrapper<RagIndexGeneration>()
                .eq(RagIndexGeneration::getStatus, "ACTIVE").orderByDesc(RagIndexGeneration::getId).last("LIMIT 1"));
        if (generation == null) return fallback("NO_ACTIVE_GENERATION");
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
        if (indexed.isEmpty()) return fallback("NO_INDEXED_SOURCE", generation);
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
                return fallback("INDEX_VERSION_MISMATCH", generation);
            }
            List<Map<String, Object>> candidates = mapList(response.get("candidates"));
            metrics.recordQuery((System.nanoTime() - started) / 1_000_000, candidates.size(), 0, 0);
            return new RetrievalResult(true, null, generation, candidates, indexed);
        } catch (Exception e) {
            return fallback(e.getClass().getSimpleName());
        }
    }

    /**
     * <b>唯一的回落出口</b>：记一次指标，再构造结果。
     *
     * <p>不变量：{@code retrieve} 的每一条非成功返回<b>恰好记一次</b>回落原因，
     * {@link #disabled()} 是唯一刻意的例外。
     *
     * <p>此前这条不变量靠「写 return 的时候记得在旁边加一行 recordFallback」维持，
     * 而那条纪律<b>已经失效过一次</b>：sidecar 不可用那一条返回压根没记指标，
     * 是拆 {@code DISABLED_OR_TOKEN_MISSING} 时偶然发现的 —— 于是 token 配错时
     * 健康信息里的原因是合并的、指标里干脆没有，两层诊断同时失效。
     *
     * <p>检索侧的改动会新增返回路径（Wiki 候选回填失败、回填时解密失败……），
     * 每一条都要记。收成一个出口之后，「新增了一条不记指标的返回路径」要写出来才行 ——
     * <b>但这是收窄不是消除</b>：同一个文件里仍能直接 {@code new RetrievalResult(false, ...)}。
     * 剩下那半由 {@code RagFallbackAccountingTest} 数构造点兜住。
     */
    private RetrievalResult fallback(String reason) {
        return fallback(reason, null);
    }

    private RetrievalResult fallback(String reason, RagIndexGeneration generation) {
        metrics.recordFallback(reason);
        return new RetrievalResult(false, reason, generation, List.of(), Set.of());
    }

    /**
     * 未启用 —— <b>唯一不记指标的非成功出口</b>，而且刻意写成一个有名字的方法。
     *
     * <p>写成 {@code if (!DISABLED.equals(r)) record(r)} 那种条件的话，
     * 「哪些原因不记」就散在条件表达式里；给它一个出口，例外就是可数的。
     */
    private RetrievalResult disabled() {
        return new RetrievalResult(false, RagClient.REASON_DISABLED, null, List.of(), Set.of());
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

    /**
     * <p><b>刻意没有 {@code unavailable(...)} 静态工厂了。</b>它是一条绕过指标记账的近路，
     * 而且看起来完全无辜 —— 留着它，收敛出口这件事就只剩一句约定。
     */
    public record RetrievalResult(boolean available, String fallbackReason, RagIndexGeneration generation,
                                  List<Map<String, Object>> candidates, Set<Long> indexedSourceIds) {
    }
}
