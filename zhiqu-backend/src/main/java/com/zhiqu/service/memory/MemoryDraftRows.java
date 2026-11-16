package com.zhiqu.service.memory;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 记忆草稿的一行（第一百四十三轮）：从「加几条」变成<b>加 / 改 / 作废</b>（学 Mem0 的写入对账）。
 *
 * <p>草稿里存的行：{@code {op: add, text}}、{@code {op: update, id, text, oldText}}、{@code {op: invalidate, id, oldText}}。
 * 老草稿只有 {@code {text}} 或一句字符串，当成 add。{@code oldText} 是建草稿时那一条的原文，
 * 只给用户看（确认时以库里的为准，库里那条不在了就拒绝）。
 *
 * <p>纯函数，判据直接喂。
 */
public final class MemoryDraftRows {

    public static final int MAX_ROWS = 20;

    private MemoryDraftRows() {}

    /** 给整理器看的现有条目：一条一行，带 #编号。 */
    public static String listing(List<LongTermMemoryStore.Item> current) {
        StringBuilder sb = new StringBuilder();
        for (LongTermMemoryStore.Item i : current) {
            if (!sb.isEmpty()) sb.append('\n');
            sb.append('#').append(i.id()).append(' ').append(i.plain());
        }
        return sb.toString();
    }

    /**
     * 解析整理器（或 {@code propose_memory}）给的数组。元素可以是一句话（= add），或者 {@code {op, id, text}}。
     * 指向不存在的编号的 update / invalidate 丢掉（模型编的编号）；同一条既改又作废只留第一个；和现有条目一字不差的 add 丢掉。
     */
    public static List<Map<String, Object>> parse(List<?> raw, List<LongTermMemoryStore.Item> current, int maxChars) {
        Map<Long, String> byId = new LinkedHashMap<>();
        Set<String> existing = new LinkedHashSet<>();
        for (LongTermMemoryStore.Item i : current) {
            byId.put(i.id(), i.plain());
            existing.add(norm(i.plain()));
        }
        List<Map<String, Object>> out = new ArrayList<>();
        Set<Long> touched = new LinkedHashSet<>();
        Set<String> added = new LinkedHashSet<>();
        for (Object o : raw == null ? List.of() : raw) {
            if (out.size() >= MAX_ROWS) break;
            String op = "add";
            Long id = null;
            String text;
            if (o instanceof Map<?, ?> m) {
                Object rawOp = m.get("op");
                op = rawOp == null ? "add" : String.valueOf(rawOp).trim().toLowerCase();
                id = longOf(m.get("id"));
                text = m.get("text") == null ? "" : String.valueOf(m.get("text"));
            } else {
                text = o == null ? "" : String.valueOf(o);
            }
            text = clip(LongTermMemoryStore.plainOf(text.replaceAll("\\s+", " ")), maxChars);
            Map<String, Object> row = new LinkedHashMap<>();
            switch (op) {
                case "add" -> {
                    if (text.isEmpty() || existing.contains(norm(text)) || !added.add(norm(text))) continue;
                    row.put("op", "add");
                    row.put("text", text);
                }
                case "update", "invalidate" -> {
                    if (id == null || !byId.containsKey(id) || !touched.add(id)) continue;
                    if ("update".equals(op) && (text.isEmpty() || norm(text).equals(norm(byId.get(id))))) continue;
                    row.put("op", op);
                    row.put("id", id);
                    if ("update".equals(op)) row.put("text", text);
                    row.put("oldText", byId.get(id));
                }
                default -> { continue; }
            }
            out.add(row);
        }
        return out;
    }

    /** 从模型的回答里切出 JSON 数组；切不出来就是「这一轮没有」。 */
    public static List<?> arrayIn(ObjectMapper json, String raw) {
        if (raw == null) return List.of();
        String text = raw.trim();
        int start = text.indexOf('[');
        int end = text.lastIndexOf(']');
        if (start < 0 || end <= start) return List.of();
        try {
            return json.readValue(text.substring(start, end + 1), List.class);
        } catch (Exception e) {
            return List.of();
        }
    }

    /**
     * 确认时要做的改动。请求体带 {@code items} 时以它为准（用户逐条勾选后的结果），否则整份接受。
     * 请求体只用来<b>挑</b>：update / invalidate 的编号必须是草稿里本来就有的那几个（请求体不能把草稿变成「作废我所有的记忆」）；
     * add 的文字照旧可以是用户在弹窗里勾的那几句（老前端只回 text）。
     */
    public static List<LongTermMemoryStore.Change> changes(List<?> draftRows, Object body) {
        List<Map<String, Object>> draft = rows(draftRows);
        List<Map<String, Object>> chosen = body instanceof List<?> picked ? rows(picked) : draft;
        Map<Long, Map<String, Object>> draftById = new LinkedHashMap<>();
        for (Map<String, Object> r : draft) {
            Long id = longOf(r.get("id"));
            if (id != null) draftById.put(id, r);
        }
        List<LongTermMemoryStore.Change> out = new ArrayList<>();
        for (Map<String, Object> r : chosen) {
            String op = r.get("op") == null ? "add" : String.valueOf(r.get("op"));
            Long id = longOf(r.get("id"));
            if ("update".equals(op) || "invalidate".equals(op)) {
                Map<String, Object> d = id == null ? null : draftById.get(id);
                if (d == null || !op.equals(String.valueOf(d.get("op")))) continue;
                out.add("update".equals(op) ? LongTermMemoryStore.Change.update(id, String.valueOf(d.get("text")))
                        : LongTermMemoryStore.Change.invalidate(id));
            } else {
                String text = r.get("text") == null ? "" : String.valueOf(r.get("text")).trim();
                if (!text.isEmpty()) out.add(LongTermMemoryStore.Change.add(text));
            }
        }
        return out;
    }

    /** 草稿行统一成 Map（老草稿的一行可能就是一句字符串）。 */
    private static List<Map<String, Object>> rows(List<?> raw) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object o : raw == null ? List.of() : raw) {
            if (o instanceof Map<?, ?> m) {
                Map<String, Object> r = new LinkedHashMap<>();
                m.forEach((k, v) -> r.put(String.valueOf(k), v));
                out.add(r);
            } else if (o != null && !String.valueOf(o).isBlank()) {
                out.add(new LinkedHashMap<>(Map.of("op", "add", "text", String.valueOf(o))));
            }
        }
        return out;
    }

    private static Long longOf(Object v) {
        if (v instanceof Number n) return n.longValue();
        if (v == null) return null;
        String s = String.valueOf(v).trim();
        if (s.startsWith("#")) s = s.substring(1);
        try { return Long.parseLong(s); } catch (NumberFormatException e) { return null; }
    }

    private static String clip(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max);
    }

    private static String norm(String s) {
        return s == null ? "" : s.replaceAll("\\s+", " ").strip().toLowerCase();
    }
}
