package com.zhiqu.tmpperf;

import com.zhiqu.service.knowledge.KnowledgeVaultCodec;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashSet;
import java.util.Set;

class VaultResolvePerfTmpTest {
    @Test
    void time() {
        Set<String> notes = new LinkedHashSet<>(), files = new LinkedHashSet<>();
        for (int i = 0; i < 1000; i++) notes.add("目录" + (i % 20) + "/笔记" + i + ".md");
        for (int i = 0; i < 3000; i++) files.add("附件/图" + i + ".png");
        long t0 = System.nanoTime(); int hits = 0;
        for (int i = 0; i < 2000; i++) {
            String from = "目录" + (i % 20) + "/笔记" + (i % 1000) + ".md";
            if (KnowledgeVaultCodec.resolve(from, "笔记" + ((i * 7) % 1000), notes) != null) hits++;
            if (KnowledgeVaultCodec.resolve(from, "图" + (i % 3000) + ".png", files) != null) hits++;
        }
        long ms = (System.nanoTime() - t0) / 1_000_000;
        System.out.println("PERF 2000 links: " + ms + " ms, hits=" + hits + " → 20000 links ≈ " + (ms * 10) + " ms per pass");
    }
}
