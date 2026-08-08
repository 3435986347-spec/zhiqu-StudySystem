package com.zhiqu.rag;

import org.springframework.stereotype.Service;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

@Service
public class RagMetricsService {
    private static final int MAX_LATENCIES = 1000;
    private final Object latencyLock = new Object();
    private final ArrayDeque<Long> queryLatencies = new ArrayDeque<>();
    private final Map<String, AtomicLong> fallbacks = new ConcurrentHashMap<>();
    private final AtomicLong candidatesReturned = new AtomicLong();
    private final AtomicLong candidatesHydrated = new AtomicLong();
    private final AtomicLong candidatesFinal = new AtomicLong();
    private final Map<String, AtomicLong> droppedCandidates = new ConcurrentHashMap<>();

    /** 跨作用域候选被丢弃的原因名，同时是旧快照键 {@code crossScopeDrops} 的来源。 */
    static final String REASON_CROSS_SCOPE = "CROSS_SCOPE";
    private static final String UNKNOWN_NAMESPACE = "UNKNOWN";

    public void recordQuery(long latencyMs, int returned, int hydrated, int selected) {
        synchronized (latencyLock) {
            queryLatencies.addLast(Math.max(0, latencyMs));
            while (queryLatencies.size() > MAX_LATENCIES) queryLatencies.removeFirst();
        }
        candidatesReturned.addAndGet(Math.max(0, returned));
        candidatesHydrated.addAndGet(Math.max(0, hydrated));
        candidatesFinal.addAndGet(Math.max(0, selected));
    }

    public void recordFallback(String reason) {
        fallbacks.computeIfAbsent(reason == null ? "UNKNOWN" : reason, ignored -> new AtomicLong()).incrementAndGet();
    }

    /**
     * 一条候选没能进入上下文 —— <b>而这次检索仍然是成功的</b>。
     *
     * <p>存在的理由是{@code fallback(...)} 的粒度接不住这种失败。回落记账是
     * <b>每次检索一次、二值的</b>（可用 / 不可用）；而 Wiki 单元接进来之后出现了一种新形态：
     * 某一条候选回填失败（一页密文坏了 —— {@code DECRYPT_FAILED} 在生产里发生过），
     * 检索却照常返回。于是模型少拿一份资料、回答质量下降，
     * 而 {@code recordFallback} 一次没记 —— 因为它根本没走任何 unavailable 出口。
     *
     * <p>那正是本仓库「声称存在、实际未接线」那一族的形状，只是这次不是忘了接线，
     * 是<b>记账模型的粒度接不住这种失败</b>。让粒度与失败的粒度一致，
     * 顺带拿到「哪个命名空间在掉」这个诊断维度 —— Wiki 接进来之后那是最需要的一维。
     *
     * <p><b>硬约束：只记 {@code unitId} 与原因，绝不记内容片段。</b>
     * 回填出来的 Wiki 正文是解密后的明文，它进模型上下文是设计内的，
     * 但不能进日志、不能进 {@code ai_agent_step} 的明文列。排查时想看内容会很自然，
     * 而那正是加密边界被打穿的方式。本方法的签名里因此<b>没有</b>可以放内容的位置。
     */
    public void recordDroppedCandidate(String namespace, String reason) {
        String key = (namespace == null || namespace.isBlank() ? UNKNOWN_NAMESPACE : namespace)
                + ":" + (reason == null || reason.isBlank() ? "UNKNOWN" : reason);
        droppedCandidates.computeIfAbsent(key, ignored -> new AtomicLong()).incrementAndGet();
    }

    /**
     * 跨作用域候选被丢弃。<b>走的是同一个计数器</b>，不是第二处记账 ——
     * 旧的两个快照键由它派生（前端在读，不动）。
     */
    public void recordCrossScopeDrop() {
        recordDroppedCandidate(null, REASON_CROSS_SCOPE);
    }

    private long crossScopeDropped() {
        return droppedCandidates.entrySet().stream()
                .filter(entry -> entry.getKey().endsWith(":" + REASON_CROSS_SCOPE))
                .mapToLong(entry -> entry.getValue().get()).sum();
    }

    public void recordCandidateFlow(int hydrated, int selected) {
        candidatesHydrated.addAndGet(Math.max(0, hydrated));
        candidatesFinal.addAndGet(Math.max(0, selected));
    }

    public Map<String, Object> snapshot() {
        List<Long> sorted;
        synchronized (latencyLock) {
            sorted = new ArrayList<>(queryLatencies);
        }
        sorted.sort(Comparator.naturalOrder());
        Map<String, Long> fallbackSnapshot = new LinkedHashMap<>();
        fallbacks.entrySet().stream().sorted(Map.Entry.comparingByKey())
                .forEach(entry -> fallbackSnapshot.put(entry.getKey(), entry.getValue().get()));
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("queryCount", sorted.size());
        result.put("queryLatencyP50Ms", percentile(sorted, 0.50));
        result.put("queryLatencyP95Ms", percentile(sorted, 0.95));
        result.put("queryP50Ms", percentile(sorted, 0.50));
        result.put("queryP95Ms", percentile(sorted, 0.95));
        result.put("fallbacks", fallbackSnapshot);
        result.put("fallbackCount", fallbackSnapshot.values().stream().mapToLong(Long::longValue).sum());
        result.put("candidatesReturned", candidatesReturned.get());
        result.put("candidatesHydrated", candidatesHydrated.get());
        result.put("candidatesFinal", candidatesFinal.get());
        Map<String, Long> droppedSnapshot = new LinkedHashMap<>();
        droppedCandidates.entrySet().stream().sorted(Map.Entry.comparingByKey())
                .forEach(entry -> droppedSnapshot.put(entry.getKey(), entry.getValue().get()));
        result.put("droppedCandidates", droppedSnapshot);
        result.put("droppedCandidateCount", droppedSnapshot.values().stream().mapToLong(Long::longValue).sum());
        // 旧的两个键由同一个计数器派生 —— 前端在读，保持不变；但它们不再是独立的一处记账。
        result.put("crossScopeCandidateDropped", crossScopeDropped());
        result.put("crossScopeDrops", crossScopeDropped());
        return result;
    }

    private long percentile(List<Long> values, double percentile) {
        if (values.isEmpty()) return 0;
        int index = (int) Math.ceil(values.size() * percentile) - 1;
        return values.get(Math.max(0, Math.min(values.size() - 1, index)));
    }
}
