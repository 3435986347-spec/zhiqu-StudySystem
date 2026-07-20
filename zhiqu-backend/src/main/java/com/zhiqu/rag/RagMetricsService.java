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
    private final AtomicLong crossScopeDropped = new AtomicLong();

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

    public void recordCrossScopeDrop() {
        crossScopeDropped.incrementAndGet();
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
        result.put("crossScopeCandidateDropped", crossScopeDropped.get());
        result.put("crossScopeDrops", crossScopeDropped.get());
        return result;
    }

    private long percentile(List<Long> values, double percentile) {
        if (values.isEmpty()) return 0;
        int index = (int) Math.ceil(values.size() * percentile) - 1;
        return values.get(Math.max(0, Math.min(values.size() - 1, index)));
    }
}
