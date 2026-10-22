package com.zhiqu.service.knowledge;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/** A bounded, declarative view description; active documents are always plain source text. */
final class KnowledgeAttachmentPreview {
    static final int MAX_TEXT_BYTES = 512 * 1024;
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Set<String> TEXT_EXTENSIONS = Set.of("txt", "text", "md", "markdown", "json", "jsonl", "ndjson",
            "canvas", "yaml", "yml", "toml", "ini", "conf", "cfg", "properties", "log", "csv", "tsv", "xml", "svg",
            "html", "htm", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "java", "py", "rb", "go", "rs",
            "c", "h", "cpp", "hpp", "cs", "sh", "bash", "zsh", "ps1", "sql", "proto", "graphql", "vue", "svelte");
    private KnowledgeAttachmentPreview() { }

    static Map<String, Object> describe(KnowledgeImageService.AttachmentData data) {
        var file = data.attachment();
        byte[] bytes = data.bytes();
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("id", file.id()); result.put("name", file.name()); result.put("kind", file.kind());
        result.put("mimeType", "application/octet-stream"); result.put("byteSize", file.byteSize());
        result.put("previewType", "FILE");
        String name = file.name().toLowerCase(Locale.ROOT);
        String extension = name.substring(name.lastIndexOf('.') + 1);
        if ("IMAGE".equals(file.kind()) && Set.of("image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp").contains(file.mimeType())) {
            type(result, "IMAGE", file.mimeType());
        } else if (extension.equals("pdf") && starts(bytes, "%PDF-")) {
            type(result, "PDF", "application/pdf");
        } else {
            String media = mediaMime(extension, bytes);
            if (media != null) {
                type(result, media.startsWith("audio/") ? "AUDIO" : "VIDEO", media);
            } else if (TEXT_EXTENSIONS.contains(extension) || Set.of("readme", "license", "dockerfile", "makefile", ".gitignore", ".env").contains(name)) {
                addText(result, extension, bytes);
            }
        }
        return result;
    }

    private static void addText(Map<String, Object> result, String extension, byte[] bytes) {
        String all;
        try {
            all = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
        } catch (Exception e) { return; }
        // Valid UTF-8 alone does not distinguish ordinary source text from a binary file.
        if (all.chars().anyMatch(c -> Character.isISOControl(c) && c != '\t' && c != '\n' && c != '\r' && c != '\f')) return;
        int end = Math.min(bytes.length, MAX_TEXT_BYTES);
        while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) == 0x80) end--;
        String text = new String(bytes, 0, end, StandardCharsets.UTF_8);
        boolean truncated = end < bytes.length;
        type(result, "TEXT", "text/plain");
        if ((extension.equals("json") || extension.equals("canvas")) && !truncated) {
            try {
                String candidate = all.startsWith("\ufeff") ? all.substring(1) : all;
                // Fail on a second root value; a valid prefix must not hide malformed trailing data.
                JsonNode parsed = JSON.reader().with(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS).readTree(candidate);
                if (parsed != null) {
                    // JSON Canvas 1.0 makes both collections optional (including an empty {} canvas).
                    boolean canvas = extension.equals("canvas") && parsed.isObject()
                            && (!parsed.has("nodes") || parsed.path("nodes").isArray())
                            && (!parsed.has("edges") || parsed.path("edges").isArray());
                    type(result, canvas ? "CANVAS" : "JSON", "application/json");
                }
            } catch (Exception e) { result.put("warning", "JSON 格式不完整，按原文展示"); }
        }
        result.put("text", text); result.put("truncated", truncated);
    }

    private static void type(Map<String, Object> result, String preview, String mime) {
        result.put("previewType", preview); result.put("mimeType", mime);
    }

    private static String mediaMime(String extension, byte[] bytes) {
        if (extension.equals("mp3") && (starts(bytes, "ID3") && bytes.length >= 10
                || bytes.length >= 4 && (bytes[0] & 0xff) == 0xff && (bytes[1] & 0xe0) == 0xe0
                    && (bytes[1] & 6) != 0 && (bytes[2] & 0xf0) != 0xf0 && (bytes[2] & 0x0c) != 0x0c)) return "audio/mpeg";
        if (extension.equals("wav") && starts(bytes, "RIFF") && at(bytes, 8, "WAVE") && bytes.length >= 12) return "audio/wav";
        if (extension.equals("flac") && starts(bytes, "fLaC") && bytes.length >= 8) return "audio/flac";
        if (Set.of("ogg", "oga", "opus").contains(extension) && starts(bytes, "OggS") && bytes.length >= 27) return "audio/ogg";
        if (Set.of("ogv").contains(extension) && starts(bytes, "OggS") && bytes.length >= 27) return "video/ogg";
        if (extension.equals("webm") && bytes.length >= 8 && (bytes[0] & 0xff) == 0x1a && bytes[1] == 0x45
                && (bytes[2] & 0xff) == 0xdf && (bytes[3] & 0xff) == 0xa3) return "video/webm";
        if (Set.of("mp4", "m4v", "m4a", "mov", "3gp").contains(extension) && isoMedia(bytes)) {
            return switch (extension) {
                case "m4a" -> "audio/mp4";
                case "mov" -> "video/quicktime";
                case "3gp" -> "video/3gpp";
                default -> "video/mp4";
            };
        }
        return null;
    }

    private static boolean isoMedia(byte[] bytes) {
        if (bytes.length < 16 || !at(bytes, 4, "ftyp")) return false;
        long size = ((long) (bytes[0] & 0xff) << 24) | ((long) (bytes[1] & 0xff) << 16)
                | ((long) (bytes[2] & 0xff) << 8) | (bytes[3] & 0xff);
        if (size < 16 || size > bytes.length || size > 4096 || size % 4 != 0) return false;
        for (int offset = 8; offset < size; offset += 4) {
            if (offset == 12) continue;
            if (Set.of("isom", "iso2", "mp41", "mp42", "M4A ", "M4V ", "qt  ", "3gp4", "3gp5", "avc1", "dash").contains(
                    new String(bytes, offset, 4, StandardCharsets.US_ASCII))) return true;
        }
        return false;
    }
    private static boolean starts(byte[] bytes, String value) { return at(bytes, 0, value); }
    private static boolean at(byte[] bytes, int offset, String value) {
        if (offset + value.length() > bytes.length) return false;
        for (int i = 0; i < value.length(); i++) if (bytes[offset + i] != value.charAt(i)) return false;
        return true;
    }
}
