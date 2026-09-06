package com.zhiqu.pdfeval.runner;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.pdfeval.model.ParseElement;
import com.zhiqu.pdfeval.model.ParseResult;
import com.zhiqu.pdfeval.model.ParsedDocument;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.*;

public final class RunnerSupport {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private RunnerSupport() {}

    public static void serve(String engine, String version, DocumentParser parser, Runnable shutdown) throws Exception {
        PrintStream protocolStream = System.out;
        System.setOut(System.err);
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
             BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(protocolStream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isBlank()) continue;
                writer.write(MAPPER.writeValueAsString(execute(engine, version, parser, line)));
                writer.newLine();
                writer.flush();
            }
        } finally {
            if (shutdown != null) shutdown.run();
        }
    }

    private static ParseResult execute(String engine, String version, DocumentParser parser, String requestJson) {
        long started = System.nanoTime();
        RunnerRequest request = null;
        try {
            request = MAPPER.readValue(requestJson, RunnerRequest.class);
            if (request.input() == null || request.input().isBlank()) throw new IllegalArgumentException("input is required");
            Path input = Path.of(request.input()).toAbsolutePath().normalize();
            if (!Files.isRegularFile(input)) throw new IllegalArgumentException("PDF file does not exist: " + input);
            if (!input.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".pdf")) {
                throw new IllegalArgumentException("only PDF files are supported");
            }
            if (Files.size(input) > request.resolvedMaxFileBytes()) {
                throw new IllegalArgumentException("PDF exceeds maxFileBytes=" + request.resolvedMaxFileBytes());
            }
            ParsedDocument parsed = parser.parse(input, request.resolvedMaxPages());
            if (parsed.pageCount() > request.resolvedMaxPages()) {
                throw new IllegalArgumentException("PDF exceeds maxPages=" + request.resolvedMaxPages());
            }
            TruncatedText text = truncate(parsed.text(), request.resolvedMaxOutputChars());
            TruncatedText markdown = truncate(parsed.markdown(), request.resolvedMaxOutputChars());
            List<ParseElement> elements = limitElements(parsed.elements(), request.resolvedMaxOutputChars());
            boolean truncated = text.truncated() || markdown.truncated()
                    || elements.size() < safeList(parsed.elements()).size();
            List<String> warnings = new ArrayList<>(safeList(parsed.warnings()));
            if (truncated) warnings.add("output truncated by benchmark safety limit");
            boolean needsOcr = needsOcr(text.value(), parsed.pageCount());
            if (needsOcr) warnings.add("insufficient selectable text; OCR is required");
            return new ParseResult(request.requestId(), engine, version, sha256(input), parsed.pageCount(),
                    text.value(), markdown.value(), elements, elapsedMs(started), -1L,
                    warnings, null, truncated, needsOcr);
        } catch (Throwable error) {
            return new ParseResult(request == null ? null : request.requestId(), engine, version, null,
                    0, "", "", List.of(), elapsedMs(started), -1L, List.of(), safeError(error), false, false);
        }
    }

    private static List<ParseElement> limitElements(List<ParseElement> input, int maxChars) {
        List<ParseElement> output = new ArrayList<>();
        int used = 0;
        for (ParseElement element : safeList(input)) {
            String content = element.content() == null ? "" : element.content();
            if (used + content.length() > maxChars) break;
            output.add(element);
            used += content.length();
        }
        return output;
    }

    private static boolean needsOcr(String text, int pageCount) {
        long visible = text == null ? 0 : text.codePoints().filter(value -> !Character.isWhitespace(value)).count();
        return pageCount > 0 && visible / pageCount < 20;
    }

    private static TruncatedText truncate(String input, int maxChars) {
        String value = input == null ? "" : input;
        return value.length() <= maxChars ? new TruncatedText(value, false)
                : new TruncatedText(value.substring(0, maxChars), true);
    }

    private static String sha256(Path path) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = Files.newInputStream(path)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) >= 0) if (read > 0) digest.update(buffer, 0, read);
        }
        return HexFormat.of().formatHex(digest.digest());
    }

    private static long elapsedMs(long started) {
        return Math.max(0L, (System.nanoTime() - started) / 1_000_000L);
    }

    private static String safeError(Throwable error) {
        String message = error.getMessage();
        String value = error.getClass().getSimpleName() + (message == null || message.isBlank() ? "" : ": " + message);
        return value.length() <= 1000 ? value : value.substring(0, 1000);
    }

    private static <T> List<T> safeList(List<T> value) {
        return value == null ? List.of() : value;
    }

    private record TruncatedText(String value, boolean truncated) {}
}
