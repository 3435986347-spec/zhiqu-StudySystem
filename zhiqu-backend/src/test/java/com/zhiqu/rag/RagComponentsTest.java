package com.zhiqu.rag;

import com.zhiqu.entity.AiSourceChunk;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RagComponentsTest {
    @Test
    void parentHashIsStableAndOrderedByChunkIndex() {
        RagContentHashService service = new RagContentHashService();
        AiSourceChunk second = chunk(2L, 1, "后半段");
        AiSourceChunk first = chunk(1L, 0, "前半段");
        String hash = service.hashParentChunks(List.of(second, first));
        assertEquals(hash, service.hashParentChunks(List.of(first, second)));
        assertEquals(hash, service.hashChunkTexts(List.of("前半段", "后半段")));
        assertEquals(64, hash.length());
    }

    @Test
    void budgetLimitsPerSourceAndTotalCandidates() {
        RagProperties properties = new RagProperties();
        properties.setFinalK(4);
        properties.setMaxPerSource(2);
        properties.setMaxContextChars(1000);
        ContextBudgeter budgeter = new ContextBudgeter(properties);
        List<Map<String, Object>> rows = new ArrayList<>();
        rows.add(row(1, 1, "a"));
        rows.add(row(1, 2, "b"));
        rows.add(row(1, 3, "c"));
        rows.add(row(2, 4, "d"));
        rows.add(row(2, 4, "duplicate"));

        List<Map<String, Object>> selected = budgeter.select(rows, List.of(), 2);
        assertEquals(3, selected.size());
        assertEquals(2, selected.stream().filter(item -> item.get("sourceId").equals(1L)).count());
        assertTrue(selected.stream().noneMatch(item -> "duplicate".equals(item.get("content"))));
    }

    @Test
    void budgetIsAHardCharacterLimitEvenForFirstCandidate() {
        RagProperties properties = new RagProperties();
        properties.setFinalK(8);
        properties.setMaxContextChars(5);
        ContextBudgeter budgeter = new ContextBudgeter(properties);

        List<Map<String, Object>> selected = budgeter.select(List.of(row(1, 1, "123456789")), List.of(), 1);

        assertEquals(1, selected.size());
        assertEquals("12345", selected.get(0).get("content"));
    }

    @Test
    void explicitSupplementKeepsASlotAheadOfVectorCandidates() {
        RagProperties properties = new RagProperties();
        properties.setFinalK(2);
        properties.setMaxContextChars(1000);
        ContextBudgeter budgeter = new ContextBudgeter(properties);
        Map<String, Object> explicitWiki = row(9, 9, "explicit wiki");
        explicitWiki.put("sourceType", "WIKI_PAGE");
        explicitWiki.put("_explicit", true);

        List<Map<String, Object>> selected = budgeter.select(
                List.of(row(1, 1, "vector one"), row(2, 2, "vector two")),
                List.of(explicitWiki), 2);

        assertEquals(2, selected.size());
        assertEquals("explicit wiki", selected.get(0).get("content"));
        assertTrue(selected.stream().noneMatch(item -> item.containsKey("_explicit")));
    }

    @Test
    void explicitAttachmentCannotStarveExplicitWiki() {
        RagProperties properties = new RagProperties();
        properties.setFinalK(2);
        properties.setMaxPerSource(3);
        properties.setMaxContextChars(1000);
        ContextBudgeter budgeter = new ContextBudgeter(properties);
        List<Map<String, Object>> explicit = new ArrayList<>();
        for (int chunk = 1; chunk <= 8; chunk++) {
            Map<String, Object> attachment = row(1, chunk, "attachment " + chunk);
            attachment.put("_explicit", true);
            explicit.add(attachment);
        }
        Map<String, Object> wiki = row(9, 9, "explicit wiki");
        wiki.put("sourceType", "WIKI_PAGE");
        wiki.put("_explicit", true);
        explicit.add(wiki);

        List<Map<String, Object>> selected = budgeter.select(List.of(), explicit, 1);

        assertEquals(2, selected.size());
        assertEquals("attachment 1", selected.get(0).get("content"));
        assertEquals("explicit wiki", selected.get(1).get("content"));
    }

    @Test
    void budgetCropStaysCenteredOnSemanticHit() {
        RagProperties properties = new RagProperties();
        properties.setFinalK(1);
        properties.setMaxContextChars(6);
        ContextBudgeter budgeter = new ContextBudgeter(properties);
        Map<String, Object> candidate = row(1, 1, "aaaaTARGETbbbb");
        candidate.put("_hitStart", 4);
        candidate.put("_hitEnd", 10);

        List<Map<String, Object>> selected = budgeter.select(List.of(candidate), List.of(), 1);

        assertEquals("TARGET", selected.get(0).get("content"));
        assertTrue(selected.get(0).keySet().stream().noneMatch(key -> key.startsWith("_hit")));
    }

    private AiSourceChunk chunk(Long id, int index, String content) {
        AiSourceChunk chunk = new AiSourceChunk();
        chunk.setId(id);
        chunk.setChunkIndex(index);
        chunk.setContent(content);
        return chunk;
    }

    private Map<String, Object> row(long sourceId, long chunkId, String content) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("sourceType", "TEXT");
        row.put("sourceId", sourceId);
        row.put("chunkId", chunkId);
        row.put("content", content);
        return row;
    }
}
