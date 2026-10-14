package com.zhiqu.service.knowledge;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.common.SystemPageTitles;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.text.Normalizer;
import java.util.*;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipOutputStream;

/** Bounded ZIP decoding. Only the compressed archive is staged; entry paths are never extracted. */
public final class KnowledgeVaultCodec {
    public static final int MAX_ZIP_BYTES = 20 * 1024 * 1024;
    public static final int MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
    public static final int MAX_ENTRIES = 3000;
    public static final int MAX_NOTES = 1000;
    private static final int MAX_NOTE_BYTES = 1024 * 1024;
    private static final int MAX_IMAGE_BYTES = 8 * 1024 * 1024;
    private static final ObjectMapper JSON = new ObjectMapper();

    public record Note(String path, String title, String type, String content, String parentPath, boolean folder) { }
    public record Archive(String hash, List<Note> notes, Map<String, byte[]> attachments, List<String> warnings) { }
    public record ExportNote(Long id, Long parentId, String title, String type, String content) { }

    public Archive decode(byte[] bytes) {
        if (bytes == null || bytes.length < 4 || bytes.length > MAX_ZIP_BYTES
                || bytes[0] != 'P' || bytes[1] != 'K') throw failure("请选择不超过 20 MiB 的 ZIP 包");
        Map<String, byte[]> files = new TreeMap<>();
        Set<String> entries = new HashSet<>();
        long expanded = 0;
        int count = 0;
        Path temporaryArchive = null;
        try {
            // Finder may use a data descriptor for STORED entries. ZipInputStream
            // rejects that valid format; ZipFile resolves it through the central directory.
            temporaryArchive = Files.createTempFile("zhiqu-wiki-vault-", ".zip");
            Files.write(temporaryArchive, bytes);
            try (ZipFile zip = new ZipFile(temporaryArchive.toFile(), StandardCharsets.UTF_8)) {
                var archiveEntries = zip.entries();
                while (archiveEntries.hasMoreElements()) {
                    ZipEntry entry = archiveEntries.nextElement();
                    if (++count > MAX_ENTRIES) throw failure("ZIP 条目超过 3000 个");
                    String path = safePath(entry.getName());
                    if (!entries.add(fold(path))) throw failure("ZIP 含重复或大小写冲突路径：" + path);
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    CRC32 crc = new CRC32();
                    byte[] block = new byte[8192];
                    try (InputStream stream = zip.getInputStream(entry)) {
                        int n;
                        while ((n = stream.read(block)) != -1) {
                            expanded += n;
                            if (expanded > MAX_EXPANDED_BYTES) throw failure("ZIP 展开内容超过 64 MiB");
                            if (out.size() + n > MAX_IMAGE_BYTES) throw failure("单个 ZIP 文件超过 8 MiB：" + path);
                            out.write(block, 0, n);
                            crc.update(block, 0, n);
                        }
                    }
                    // ZipFile streams do not validate CRC themselves. Check actual
                    // expanded bytes too; declared metadata never replaces our limits.
                    if (out.size() != entry.getSize() || crc.getValue() != entry.getCrc())
                        throw failure("ZIP 无法读取或已损坏");
                    if (!entry.isDirectory()) files.put(path, out.toByteArray());
                }
            }
        } catch (BusinessException e) { throw e; }
        catch (Exception e) { throw failure("ZIP 无法读取或已损坏"); }
        finally {
            if (temporaryArchive != null) {
                try { Files.deleteIfExists(temporaryArchive); }
                catch (IOException e) { throw failure("ZIP 临时文件清理失败，请重试"); }
            }
        }
        if (files.isEmpty()) throw failure("ZIP 没有可读取的文件");
        Set<String> fileKeys = new HashSet<>(); files.keySet().forEach(path -> fileKeys.add(fold(path)));
        for (String path : fileKeys) {
            int slash = path.indexOf('/');
            while (slash >= 0) {
                if (fileKeys.contains(path.substring(0, slash))) throw failure("ZIP 的文件与目录路径冲突：" + path);
                slash = path.indexOf('/', slash + 1);
            }
        }
        Set<String> contentPaths = new TreeSet<>();
        files.keySet().stream().filter(path -> !ignored(path)).forEach(contentPaths::add);
        String root = commonRoot(contentPaths);
        Map<String, byte[]> attachments = new LinkedHashMap<>();
        Map<String, Note> notes = new TreeMap<>();
        List<String> warnings = new ArrayList<>();
        for (Map.Entry<String, byte[]> entry : files.entrySet()) {
            if (ignored(entry.getKey())) {
                String path = entry.getKey();
                warnings.add("跳过设置或系统文件：" + (path.startsWith(root) ? path.substring(root.length()) : path));
                continue;
            }
            String path = entry.getKey().substring(root.length());
            String lower = path.toLowerCase(Locale.ROOT);
            if (lower.endsWith(".md")) {
                if (entry.getValue().length > MAX_NOTE_BYTES) throw failure("笔记超过 1 MiB：" + path);
                String content = utf8(entry.getValue(), path);
                String title = fileStem(path);
                String type = "NOTE";
                if (content.startsWith("---\n") || content.startsWith("---\r\n")) {
                    int end = content.indexOf("\n---", 4);
                    if (end >= 0 && end < 16384) {
                        String metadata = content.substring(4, end);
                        String metadataTitle = scalar(metadata, "title");
                        if (metadataTitle != null && !metadataTitle.isBlank()) title = metadataTitle;
                        String metadataType = scalar(metadata, "type");
                        if (metadataType != null && metadataType.matches("[A-Za-z_]{1,40}")) type = metadataType.toUpperCase(Locale.ROOT);
                        // Keep other Obsidian frontmatter (tags/aliases/etc.) intact; strip only our exported envelope.
                        if ("1".equals(scalar(metadata, "zhiqu_vault"))) {
                            // Our envelope adds exactly one blank line. stripLeading() would also
                            // erase intentional indentation at the start of the original note.
                            String body = content.substring(end + 4);
                            if (body.startsWith("\r\n\r\n")) content = body.substring(4);
                            else if (body.startsWith("\n\n")) content = body.substring(2);
                            else if (body.startsWith("\r\n")) content = body.substring(2);
                            else if (body.startsWith("\n")) content = body.substring(1);
                            else content = body;
                        }
                    }
                }
                if (SystemPageTitles.matches(title) || Set.of("INDEX", "LOG", "SCHEMA").contains(type)) {
                    warnings.add("系统页作为普通备份笔记新增：" + path);
                    title += "（导入备份）";
                    type = "NOTE";
                }
                notes.put(path, new Note(path, cleanTitle(title), type, content, null, false));
            } else attachments.put(path, entry.getValue());
        }
        if (notes.isEmpty()) throw failure("ZIP 中没有 Markdown 笔记（.md）");
        // A parent note X.md represents X/; folders without a note get a small, ordinary directory note.
        for (String path : new ArrayList<>(notes.keySet())) {
            String parent = directory(path);
            while (!parent.isEmpty()) {
                String parentNote = parent + ".md";
                String existing = casePath(notes.keySet(), parentNote);
                if (existing == null) notes.put(parentNote, new Note(parentNote, cleanTitle(fileStem(parent)), "NOTE",
                        "# " + fileStem(parent) + "\n\n从 ZIP 导入的目录。", null, true));
                parent = directory(parent);
            }
        }
        if (notes.size() > MAX_NOTES) throw failure("ZIP 笔记与目录合计超过 1000 页");
        List<Note> ordered = new ArrayList<>();
        for (Note note : notes.values()) {
            String dir = directory(note.path());
            String parent = dir.isEmpty() ? null : casePath(notes.keySet(), dir + ".md");
            ordered.add(new Note(note.path(), note.title(), note.type(), note.content(), parent, note.folder()));
        }
        ordered.sort(Comparator.comparingInt((Note n) -> depth(n.path())).thenComparing(Note::path));
        return new Archive(sha256(bytes), List.copyOf(ordered), Collections.unmodifiableMap(attachments), List.copyOf(warnings));
    }

    public Map<Long, String> exportPaths(List<ExportNote> notes) {
        Map<Long, ExportNote> byId = new LinkedHashMap<>();
        notes.stream().sorted(Comparator.comparing(ExportNote::id)).forEach(n -> byId.put(n.id(), n));
        Map<Long, String> paths = new LinkedHashMap<>();
        Set<String> used = new HashSet<>();
        for (ExportNote note : byId.values()) exportPath(note, byId, paths, used, new HashSet<>());
        return paths;
    }

    private String exportPath(ExportNote note, Map<Long, ExportNote> notes, Map<Long, String> paths,
                              Set<String> used, Set<Long> visiting) {
        if (paths.containsKey(note.id())) return paths.get(note.id());
        if (!visiting.add(note.id())) throw failure("知识目录包含循环关系，无法导出");
        String dir = "";
        if (note.parentId() != null && notes.containsKey(note.parentId())) {
            String parent = exportPath(notes.get(note.parentId()), notes, paths, used, visiting);
            dir = parent.substring(0, parent.length() - 3) + "/";
        }
        String stem = safeFileName(note.title());
        String path = dir + stem + ".md";
        int seq = 2;
        while (!used.add(fold(path))) path = dir + stem + "-" + note.id() + (seq++ > 2 ? "-" + seq : "") + ".md";
        if (path.length() > 1000) throw failure("知识目录路径过长，无法导出");
        paths.put(note.id(), path);
        visiting.remove(note.id());
        return path;
    }

    public byte[] encode(Map<String, byte[]> files) {
        if (files.size() > MAX_ENTRIES) throw failure("导出条目超过 3000 个，请选择较小的目录");
        long bytes = 0;
        Set<String> paths = new HashSet<>();
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            try (ZipOutputStream zip = new ZipOutputStream(out, StandardCharsets.UTF_8)) {
                for (Map.Entry<String, byte[]> entry : files.entrySet()) {
                    String path = safePath(entry.getKey());
                    if (!paths.add(fold(path))) throw failure("导出路径发生冲突：" + path);
                    bytes += entry.getValue().length;
                    if (bytes > MAX_EXPANDED_BYTES) throw failure("导出内容超过 64 MiB，请选择较小的目录");
                    ZipEntry ze = new ZipEntry("wiki/" + path);
                    ze.setTime(0);
                    zip.putNextEntry(ze);
                    zip.write(entry.getValue());
                    zip.closeEntry();
                }
            }
            if (out.size() > MAX_ZIP_BYTES) throw failure("导出 ZIP 超过 20 MiB，请选择较小的目录");
            return out.toByteArray();
        } catch (BusinessException e) { throw e; }
        catch (IOException e) { throw failure("导出 ZIP 失败"); }
    }

    public static String exportedMarkdown(ExportNote note, String content) {
        try {
            return "---\nzhiqu_vault: 1\ntitle: " + JSON.writeValueAsString(note.title())
                    + "\ntype: " + (note.type() == null ? "NOTE" : note.type().replaceAll("[^A-Za-z_]", ""))
                    + "\n---\n\n" + content;
        } catch (IOException e) { throw failure("导出标题无法编码"); }
    }

    public static String resolve(String fromPath, String target, Set<String> candidates) {
        if (target == null || target.isBlank() || target.matches("^[A-Za-z][A-Za-z0-9+.-]*:.*") || target.startsWith("//")) return null;
        String decoded;
        try { decoded = java.net.URLDecoder.decode(target.replace("+", "%2B"), StandardCharsets.UTF_8); }
        catch (IllegalArgumentException e) { return null; }
        decoded = decoded.replace('\\', '/');
        // Reject after decoding too: encoded traversal or a URI must not fall back to
        // Obsidian's shortest-filename lookup inside this archive.
        if (decoded.matches("^[A-Za-z][A-Za-z0-9+.-]*:.*") || decoded.startsWith("//")) return null;
        String relative = normalizeRelative(directory(fromPath), decoded);
        if (relative == null) return null;
        String match = casePath(candidates, relative);
        if (match == null && !relative.toLowerCase(Locale.ROOT).endsWith(".md")) match = casePath(candidates, relative + ".md");
        if (match == null) match = casePath(candidates, decoded.startsWith("/") ? decoded.substring(1) : decoded);
        if (match == null && !decoded.toLowerCase(Locale.ROOT).endsWith(".md")) match = casePath(candidates, decoded + ".md");
        if (match != null) return match;
        // Obsidian's shortest unique filename syntax applies only to bare names.
        // An explicit directory that does not exist must not silently bind to an unrelated file.
        if (decoded.contains("/")) return null;
        String base = decoded.substring(decoded.lastIndexOf('/') + 1);
        List<String> matches = candidates.stream().filter(path -> {
            String filename = path.substring(path.lastIndexOf('/') + 1);
            return fold(filename).equals(fold(base)) || fold(filename).equals(fold(base + ".md"));
        }).toList();
        return matches.size() == 1 ? matches.get(0) : null;
    }

    private static String normalizeRelative(String directory, String target) {
        Deque<String> components = new ArrayDeque<>();
        String combined = target.startsWith("/") ? target.substring(1) : directory.isEmpty() ? target : directory + "/" + target;
        for (String component : combined.split("/")) {
            if (component.isEmpty() || component.equals(".")) continue;
            if (component.equals("..")) { if (components.isEmpty()) return null; components.removeLast(); }
            else components.add(component);
        }
        return String.join("/", components);
    }

    static String safePath(String path) {
        if (path == null || path.length() > 1000 || path.startsWith("/") || path.startsWith("\\")
                || path.contains("\\") || path.matches("^[A-Za-z]:.*") || path.chars().anyMatch(c -> c < 32 || c == 127))
            throw failure("ZIP 含不安全路径");
        String trimmed = path.endsWith("/") ? path.substring(0, path.length() - 1) : path;
        for (String part : trimmed.split("/", -1)) {
            if (part.isBlank() || part.equals(".") || part.equals("..") || part.endsWith(".") || part.endsWith(" ")
                    || part.matches(".*[:*?\"<>|].*") || part.matches("(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\..*)?$"))
                throw failure("ZIP 含不安全路径：" + path);
        }
        return Normalizer.normalize(trimmed, Normalizer.Form.NFC);
    }

    private static String commonRoot(Set<String> paths) {
        if (paths.isEmpty()) return "";
        String first = paths.iterator().next();
        int slash = first.indexOf('/');
        if (slash < 0) return "";
        String prefix = first.substring(0, slash + 1);
        return paths.stream().allMatch(path -> path.startsWith(prefix)) ? prefix : "";
    }
    private static boolean ignored(String path) {
        return Arrays.stream(path.split("/")).anyMatch(p -> p.equalsIgnoreCase(".obsidian") || p.equalsIgnoreCase("__MACOSX")
                || p.equalsIgnoreCase(".DS_Store") || p.startsWith("._") || p.equalsIgnoreCase(".git"));
    }
    private static String utf8(byte[] bytes, String path) {
        try {
            String result = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            return result.startsWith("\ufeff") ? result.substring(1) : result;
        } catch (Exception e) { throw failure("笔记不是有效 UTF-8：" + path); }
    }
    private static String scalar(String metadata, String key) {
        for (String line : metadata.split("\\r?\\n")) {
            if (!line.startsWith(key + ":")) continue;
            String value = line.substring(key.length() + 1).trim();
            if (value.startsWith("\"")) {
                try { return JSON.readValue(value, String.class); } catch (IOException e) { return null; }
            }
            if (value.startsWith("'") && value.endsWith("'")) return value.substring(1, value.length() - 1).replace("''", "'");
            return value.contains(" #") ? value.substring(0, value.indexOf(" #")) : value;
        }
        return null;
    }
    public static String safeFileName(String title) {
        String name = cleanTitle(title).replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "-").replaceAll("[ .]+$", "").trim();
        if (name.isBlank()) name = "untitled";
        if (name.matches("(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])$")) name = "_" + name;
        return name.length() > 80 ? name.substring(0, 80) : name;
    }
    private static String cleanTitle(String title) {
        String cleaned = title == null ? "未命名" : title.replaceAll("[\\r\\n\\p{Cntrl}]", " ").trim();
        if (cleaned.isBlank()) cleaned = "未命名";
        return cleaned.length() > 120 ? cleaned.substring(0, 120) : cleaned;
    }
    private static int depth(String path) { return path.split("/").length; }
    private static String directory(String path) { int slash = path.lastIndexOf('/'); return slash < 0 ? "" : path.substring(0, slash); }
    private static String fileStem(String path) { String filename = path.substring(path.lastIndexOf('/') + 1); return filename.toLowerCase(Locale.ROOT).endsWith(".md") ? filename.substring(0, filename.length() - 3) : filename; }
    private static String casePath(Set<String> paths, String requested) { return paths.stream().filter(p -> fold(p).equals(fold(requested))).findFirst().orElse(null); }
    public static String fold(String value) { return Normalizer.normalize(value == null ? "" : value, Normalizer.Form.NFC).toLowerCase(Locale.ROOT); }
    public static String sha256(byte[] bytes) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (Exception e) { throw new IllegalStateException(e); }
    }
    private static BusinessException failure(String message) { return new BusinessException(message); }
}
