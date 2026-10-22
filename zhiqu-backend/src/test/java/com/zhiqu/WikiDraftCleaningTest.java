package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Wiki 草稿只在 {@code WikiDrafts} 一处造（第七十四轮第六遍 review）。合入时不再洗第二遍，于是「草稿存的就是要落到页上的」——
 * 原来五个地方各自手搭草稿：两处从没洗过、有的先截断再洗、洗完是空的也照样存。规矩收进 WikiDrafts 之后，
 * 没洗过的正文进草稿在类型上写不出来（{@code WikiDrafts.Body} 只能由洗的那一步造），这条判据钉住「没有第二处在造草稿」。
 * 第五遍那版是扫「setEncryptedContent 那一行里有没有 cleanKeeping」—— contains 分不出「代码这么做」和「文本里提到」。
 */
class WikiDraftCleaningTest {

    private static final Pattern CONSTRUCTION = Pattern.compile("new\\s+(?:[\\w.]+\\.)?UserKnowledgeRevision\\s*\\(");

    @Test
    @DisplayName("全仓只有 WikiDrafts 在 new UserKnowledgeRevision（全限定名的写法也算）")
    void onlyWikiDraftsBuildsRevisions() throws Exception {
        List<String> sites = new ArrayList<>();
        try (Stream<Path> files = Files.walk(Path.of("src/main/java"))) {
            for (Path file : files.filter(p -> p.toString().endsWith(".java")).toList()) {
                String code = SourceText.stripComments(Files.readString(file));
                Matcher m = CONSTRUCTION.matcher(code);
                while (m.find()) sites.add(file.getFileName() + ":" + code.substring(0, m.start()).lines().count());
            }
        }
        assertEquals(1, sites.size(), "造 Wiki 草稿的地方应当正好一处（WikiDrafts）：" + sites);
        assertEquals("WikiDrafts.java", sites.get(0).split(":")[0], "造草稿的那一处不在 WikiDrafts 里：" + sites);
    }
}
