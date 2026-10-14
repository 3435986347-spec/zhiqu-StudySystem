package com.zhiqu.service.knowledge;

import com.zhiqu.common.BusinessException;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;

import static org.junit.jupiter.api.Assertions.*;

class KnowledgeVaultCodecTest {
    private final KnowledgeVaultCodec codec = new KnowledgeVaultCodec();

    @Test void parentNoteAndSubfolderRestoreAsOneDirectoryWhilePlainFoldersGetParents() {
        var archive = codec.decode(zip(Map.of("vault/项目.md", "父页", "vault/项目/日程.md", "[[../项目]]", "vault/资料/阅读.md", "阅读")));
        assertEquals(4, archive.notes().size());
        assertEquals("项目.md", note(archive, "项目/日程.md").parentPath());
        assertEquals("资料.md", note(archive, "资料/阅读.md").parentPath());
        assertTrue(note(archive, "资料.md").folder());
        assertEquals("父页", note(archive, "项目.md").content());
    }

    @Test void flatObsidianImagesWithSpacesWidthsAndJsonRemainByteExact() {
        Map<String, byte[]> files = new LinkedHashMap<>();
        files.put("risk/阶段.md", "[[下一步]]\n![[Pasted image 100.png|320]]\n[数据](配置.json)".getBytes(StandardCharsets.UTF_8));
        files.put("risk/下一步.md", "next".getBytes(StandardCharsets.UTF_8));
        byte[] picture = { 1, 2, 3, 4 };
        byte[] json = "{\"test\":true}".getBytes(StandardCharsets.UTF_8);
        files.put("risk/Pasted image 100.png", picture);
        files.put("risk/配置.json", json);
        files.put("risk/.obsidian/workspace.json", "ignored".getBytes(StandardCharsets.UTF_8));
        var archive = codec.decode(zipBytes(files));
        assertArrayEquals(picture, archive.attachments().get("Pasted image 100.png"));
        assertArrayEquals(json, archive.attachments().get("配置.json"));
        assertEquals(2, archive.attachments().size());
        assertEquals(1, archive.warnings().size());
        var links = VaultMarkdownLinks.read(note(archive, "阶段.md").content());
        assertTrue(links.get(1).image());
        assertEquals("320", links.get(1).label());
        assertEquals("Pasted image 100.png", links.get(1).target());
    }

    @Test void exportRetainsHierarchyAndAllocatesPortableNamesWithoutOverwriting() throws Exception {
        List<KnowledgeVaultCodec.ExportNote> notes = List.of(
                exported(1L, null, "A"), exported(2L, 1L, "子页"), exported(3L, null, "a"),
                exported(4L, null, "CON"), exported(5L, null, "A-3"));
        var paths = codec.exportPaths(notes);
        assertEquals("A/子页.md", paths.get(2L));
        assertEquals(5, new HashSet<>(paths.values().stream().map(KnowledgeVaultCodec::fold).toList()).size());
        assertEquals("_CON.md", paths.get(4L));
        Map<String, byte[]> files = new LinkedHashMap<>();
        paths.forEach((id, path) -> files.put(path, ("body" + id).getBytes(StandardCharsets.UTF_8)));
        byte[] bytes = codec.encode(files);
        assertEquals(5, codec.decode(bytes).notes().size());
        try (var zip = new ZipInputStream(new java.io.ByteArrayInputStream(bytes))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) assertTrue(entry.getName().startsWith("wiki/"));
        }
    }

    @Test void reservedSystemBackupsNeverClaimSystemTypeAndExportEnvelopePreservesQuotedTitle() {
        var note = new KnowledgeVaultCodec.ExportNote(1L, null, "阶段: \"复习\"", "NOTE", "# 内容");
        String markdown = KnowledgeVaultCodec.exportedMarkdown(note, note.content());
        var archive = codec.decode(zip(Map.of("vault/阶段.md", markdown, "vault/index.md", "---\ntype: INDEX\n---\n索引")));
        assertEquals(note.title(), note(archive, "阶段.md").title());
        assertEquals("# 内容", note(archive, "阶段.md").content());
        assertEquals("NOTE", note(archive, "index.md").type());
        assertTrue(note(archive, "index.md").title().contains("导入备份"));
    }

    @Test void exportedEnvelopeRoundTripsIntentionalLeadingWhitespace() {
        String body = "\n    indented first line\n\ncontent\n";
        var exported = new KnowledgeVaultCodec.ExportNote(1L, null, "Indent", "NOTE", body);
        var archive = codec.decode(zip(Map.of("Indent.md", KnowledgeVaultCodec.exportedMarkdown(exported, body))));
        assertEquals(body, archive.notes().get(0).content());
    }

    @Test void externalFrontmatterTagsAndAliasesRemainInNoteContent() {
        String text = "---\ntitle: 'My note'\ntags: [personal]\naliases: [alias]\n---\nHello";
        var archive = codec.decode(zip(Map.of("Note.md", text)));
        assertEquals(text, archive.notes().get(0).content());
        assertEquals("My note", archive.notes().get(0).title());
    }

    @Test void relativeWikilinksMarkdownLinksAndUniqueFilenameResolveButAmbiguousOnesDoNot() {
        Set<String> paths = Set.of("A/Note.md", "B/Note.md", "Root.md", "assets/pic one.png");
        assertEquals("Root.md", KnowledgeVaultCodec.resolve("A/Note.md", "../Root", paths));
        assertEquals("B/Note.md", KnowledgeVaultCodec.resolve("A/Note.md", "B/Note", paths));
        assertEquals("assets/pic one.png", KnowledgeVaultCodec.resolve("A/Note.md", "../assets/pic%20one.png", paths));
        assertEquals("assets/pic one.png", KnowledgeVaultCodec.resolve("A/Note.md", "pic one.png", paths));
        assertNull(KnowledgeVaultCodec.resolve("A/Note.md", "missing/pic one.png", paths));
        assertNull(KnowledgeVaultCodec.resolve("A/Note.md", "missing/Root", paths));
        assertNull(KnowledgeVaultCodec.resolve("Root.md", "Note", paths));
        assertNull(KnowledgeVaultCodec.resolve("Root.md", "https://example.com/Note.md", paths));
        assertNull(KnowledgeVaultCodec.resolve("Root.md", "../../Root.md", paths));
        assertNull(KnowledgeVaultCodec.resolve("Root.md", "%2e%2e/Root.md", paths));
        assertNull(KnowledgeVaultCodec.resolve("Root.md", "%68ttps%3A//example.com/Root.md", paths));
    }

    @Test void codeFencesInlineCodeAndEscapedLinksRemainLiteral() {
        String text = "[[real#heading|Label]] [next](folder/note.md) ![[pic.png|300]]\n"
                + "`[[inline]]` ``[[double]]`` \\[[escaped]]\n```md\n[[code]]\n```\n~~~\n[[tilde]]\n~~~\n";
        String rewritten = VaultMarkdownLinks.rewrite(text, link -> "CHANGED");
        assertTrue(rewritten.startsWith("CHANGED CHANGED CHANGED"));
        assertTrue(rewritten.contains("`[[inline]]` ``[[double]]`` \\[[escaped]]"));
        assertTrue(rewritten.contains("[[code]]"));
        assertTrue(rewritten.contains("[[tilde]]"));
        assertEquals(3, VaultMarkdownLinks.read(text).size());
        assertEquals("#heading", VaultMarkdownLinks.read(text).get(0).anchor());
        assertEquals("Label", VaultMarkdownLinks.read(text).get(0).label());
    }

    @Test void markdownAttachmentPathsWithParenthesesRemainWholeTargets() {
        var links = VaultMarkdownLinks.read("[图](diagram%20(final).png) ![图](<diagram (final).png>)");
        assertEquals(2, links.size());
        assertEquals("diagram%20(final).png", links.get(0).target());
        assertEquals("diagram (final).png", links.get(1).target());
        assertTrue(links.get(1).image());
    }

    @Test void traversalAbsoluteWindowsAndCaseAliasPathsAreRejected() {
        for (String path : List.of("../page.md", "/page.md", "C:/page.md", "x\\page.md", "x/../page.md", "NUL.md"))
            assertThrows(BusinessException.class, () -> codec.decode(zip(Map.of(path, "text"))), path);
        assertThrows(BusinessException.class, () -> codec.decode(zip(Map.of("Plan.md", "one", "plan.md", "two"))));
    }

    @Test void invalidUtf8MissingNotesAndEntryOrExpandedLimitsAreRealFailures() {
        assertThrows(BusinessException.class, () -> codec.decode(zipBytes(Map.of("bad.md", new byte[]{(byte) 0xc3, 0x28}))));
        assertThrows(BusinessException.class, () -> codec.decode(zip(Map.of("file.json", "{}"))));
        Map<String, String> tooMany = new LinkedHashMap<>();
        for (int i = 0; i <= KnowledgeVaultCodec.MAX_NOTES; i++) tooMany.put("n" + i + ".md", "note");
        assertThrows(BusinessException.class, () -> codec.decode(zip(tooMany)));
        assertThrows(BusinessException.class, () -> codec.decode(zipBytes(Map.of("large.md", new byte[1024 * 1024 + 1]))));
        Map<String, byte[]> expanded = new LinkedHashMap<>();
        for (int i = 0; i < 9; i++) expanded.put("large" + i + ".bin", new byte[8 * 1024 * 1024]);
        assertThrows(BusinessException.class, () -> codec.decode(zipBytes(expanded)));
    }

    private static KnowledgeVaultCodec.Note note(KnowledgeVaultCodec.Archive a, String path) {
        return a.notes().stream().filter(n -> n.path().equals(path)).findFirst().orElseThrow();
    }
    private static KnowledgeVaultCodec.ExportNote exported(Long id, Long parent, String title) {
        return new KnowledgeVaultCodec.ExportNote(id, parent, title, "NOTE", "body");
    }
    static byte[] zip(Map<String, String> files) {
        Map<String, byte[]> bytes = new LinkedHashMap<>();
        files.forEach((path, text) -> bytes.put(path, text.getBytes(StandardCharsets.UTF_8)));
        return zipBytes(bytes);
    }
    static byte[] zipBytes(Map<String, byte[]> files) {
        try {
            var out = new ByteArrayOutputStream();
            try (var zip = new ZipOutputStream(out, StandardCharsets.UTF_8)) {
                for (var entry : files.entrySet()) {
                    zip.putNextEntry(new ZipEntry(entry.getKey()));
                    zip.write(entry.getValue());
                    zip.closeEntry();
                }
            }
            return out.toByteArray();
        } catch (Exception e) { throw new AssertionError(e); }
    }
}
