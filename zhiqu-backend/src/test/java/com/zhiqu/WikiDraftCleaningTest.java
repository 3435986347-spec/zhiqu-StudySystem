package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Wiki 草稿入库前都要洗一遍（第七十四轮第五遍 review）。合入时不再洗第二遍（第四遍：洗两遍每次都多一次剥掉真内容的机会），
 * 于是「草稿存的就是要落到页上的」—— 而建草稿的地方有五处，两处（AI 助手存回答、工作区的 Wiki 工件）从来没洗过，
 * 原来靠合入时那一遍兜着。这条判据扫出每一处 {@code new UserKnowledgeRevision()}，要求它存正文时经过 {@code MarkdownCanonicalizer.cleanKeeping}。
 */
class WikiDraftCleaningTest {

    @Test
    @DisplayName("每一处建 Wiki 草稿的地方，存的正文都经过 cleanKeeping（不靠合入时再洗）")
    void everyDraftIsCleanedWhenItIsStored() throws Exception {
        List<String> sites = new ArrayList<>(), unclean = new ArrayList<>();
        try (Stream<Path> files = Files.walk(Path.of("src/main/java"))) {
            for (Path file : files.filter(p -> p.toString().endsWith(".java")).toList()) {
                String code = SourceText.stripComments(Files.readString(file));
                for (int at = code.indexOf("new UserKnowledgeRevision()"); at >= 0; at = code.indexOf("new UserKnowledgeRevision()", at + 1)) {
                    int end = code.indexOf(".insert(", at);
                    String creation = code.substring(at, end < 0 ? code.length() : end);
                    String where = file.getFileName() + ":" + code.substring(0, at).lines().count();
                    sites.add(where);
                    int store = creation.indexOf("setEncryptedContent(");
                    if (store < 0 || !creation.substring(store).split("\n", 2)[0].contains("MarkdownCanonicalizer.cleanKeeping(")) unclean.add(where);
                }
            }
        }
        assertTrue(sites.size() >= 5, "只扫到 " + sites.size() + " 处建草稿 —— 扫空了？" + sites);
        assertEquals(List.of(), unclean, "这几处建草稿时存的正文没经过 cleanKeeping：合入时不会再洗，模型包的那层、自述行会原样落到页上");
    }
}
