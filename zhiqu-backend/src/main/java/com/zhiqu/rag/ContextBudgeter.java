package com.zhiqu.rag;

import org.springframework.stereotype.Service;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

@Service
public class ContextBudgeter {
    private final RagProperties properties;

    public ContextBudgeter(RagProperties properties) {
        this.properties = properties;
    }

    public List<Map<String, Object>> select(List<Map<String, Object>> preferred,
                                            List<Map<String, Object>> supplements,
                                            int sourceCount) {
        List<Map<String, Object>> candidates = new ArrayList<>();
        if (supplements != null) {
            candidates.addAll(roundRobinExplicit(supplements.stream().filter(this::isExplicit).toList()));
        }
        candidates.addAll(preferred == null ? List.of() : preferred);
        if (supplements != null) {
            supplements.stream().filter(row -> !isExplicit(row)).forEach(candidates::add);
        }
        List<Map<String, Object>> selected = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        Map<String, Integer> perSource = new HashMap<>();
        int effectiveSourceCount = Math.max(sourceCount,
                (int) candidates.stream().map(this::sourceKey).distinct().count());
        int chars = 0;
        for (Map<String, Object> row : candidates) {
            // 去重键 = 桶键 + 块标识。桶键那两段缺失即抛（见 CandidateKeys.sourceKeyOf）——
            // 回落成空串的话，跨命名空间的 chunkId 撞上就会被误判成重复行。
            String key = CandidateKeys.sourceKeyOf(row) + ":"
                    + row.getOrDefault(CandidateKeys.CHUNK_ID,
                            row.getOrDefault(CandidateKeys.CHUNK_INDEX, ""));
            if (!seen.add(key)) continue;
            String sourceKey = sourceKey(row);
            if (effectiveSourceCount > 1 && perSource.getOrDefault(sourceKey, 0) >= properties.getMaxPerSource()) continue;
            String content = String.valueOf(row.getOrDefault(CandidateKeys.CONTENT, ""));
            int remaining = properties.getMaxContextChars() - chars;
            if (remaining <= 0) break;
            if (content.length() > remaining) content = cropToBudget(row, content, remaining);
            if (content.isBlank()) continue;
            Map<String, Object> clean = new LinkedHashMap<>(row);
            clean.remove(CandidateKeys.SCORE);
            clean.remove(CandidateKeys.EXPLICIT);
            clean.remove(CandidateKeys.HIT_START);
            clean.remove(CandidateKeys.HIT_END);
            clean.put(CandidateKeys.CONTENT, content);
            selected.add(clean);
            chars += content.length();
            perSource.merge(sourceKey, 1, Integer::sum);
            if (selected.size() >= properties.getFinalK() || chars >= properties.getMaxContextChars()) break;
        }
        return selected;
    }

    private boolean isExplicit(Map<String, Object> row) {
        return row != null && Boolean.TRUE.equals(row.get(CandidateKeys.EXPLICIT));
    }

    private List<Map<String, Object>> roundRobinExplicit(List<Map<String, Object>> rows) {
        Map<String, ArrayDeque<Map<String, Object>>> bySource = new LinkedHashMap<>();
        for (Map<String, Object> row : rows) {
            bySource.computeIfAbsent(sourceKey(row), ignored -> new ArrayDeque<>()).add(row);
        }
        List<Map<String, Object>> ordered = new ArrayList<>();
        boolean remaining;
        do {
            remaining = false;
            for (ArrayDeque<Map<String, Object>> queue : bySource.values()) {
                Map<String, Object> row = queue.pollFirst();
                if (row != null) {
                    ordered.add(row);
                    remaining = true;
                }
            }
        } while (remaining);
        return ordered;
    }

    private String sourceKey(Map<String, Object> row) {
        return CandidateKeys.sourceKeyOf(row);
    }

    private String cropToBudget(Map<String, Object> row, String content, int remaining) {
        if (remaining >= content.length()) return content;
        int hitStart = intValue(row.get(CandidateKeys.HIT_START), -1);
        int hitEnd = intValue(row.get(CandidateKeys.HIT_END), hitStart);
        if (hitStart < 0 || hitStart > content.length()) return content.substring(0, remaining);
        hitEnd = Math.max(hitStart, Math.min(content.length(), hitEnd));
        int center = (hitStart + hitEnd) / 2;
        int start = Math.max(0, center - remaining / 2);
        int end = Math.min(content.length(), start + remaining);
        start = Math.max(0, end - remaining);
        return content.substring(start, end);
    }

    private int intValue(Object value, int fallback) {
        if (value instanceof Number number) return number.intValue();
        try { return Integer.parseInt(String.valueOf(value)); } catch (Exception ignored) { return fallback; }
    }
}
