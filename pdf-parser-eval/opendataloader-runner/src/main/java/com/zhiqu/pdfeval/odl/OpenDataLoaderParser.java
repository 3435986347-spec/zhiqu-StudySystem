package com.zhiqu.pdfeval.odl;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.pdfeval.model.ParseElement;
import com.zhiqu.pdfeval.model.ParsedDocument;
import com.zhiqu.pdfeval.runner.DocumentParser;
import org.opendataloader.pdf.api.Config;
import org.opendataloader.pdf.api.OpenDataLoaderPDF;

import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.stream.Stream;

public final class OpenDataLoaderParser implements DocumentParser {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Override
    public ParsedDocument parse(Path input, int maxPages) throws Exception {
        Path output = Files.createTempDirectory("zhiqu-odl-eval-");
        try {
            Config config = new Config();
            config.setOutputFolder(output.toString());
            config.setGenerateJSON(true);
            config.setGenerateMarkdown(true);
            config.setGenerateText(true);
            config.setGenerateHtml(false);
            config.setGeneratePDF(false);
            config.setGenerateTaggedPDF(false);
            config.setImageOutput(Config.IMAGE_OUTPUT_OFF);
            config.setHybrid(Config.HYBRID_OFF);
            config.setReadingOrder(Config.READING_ORDER_XYCUT);
            config.setIncludeHeaderFooter(false);
            config.setOutputStdout(false);
            config.setThreads(1);
            OpenDataLoaderPDF.processFile(input.toString(), config);

            Path jsonPath = requiredOutput(output, ".json");
            JsonNode root = MAPPER.readTree(jsonPath.toFile());
            int pageCount = root.path("number of pages").asInt(0);
            if (pageCount <= 0) pageCount = maxPageNumber(root);
            if (pageCount > maxPages) throw new IllegalArgumentException("PDF exceeds maxPages=" + maxPages);

            String markdown = readOptionalOutput(output, ".md");
            String text = readOptionalOutput(output, ".txt");
            List<ParseElement> elements = new ArrayList<>();
            collectElements(root.path("kids"), elements, 0);
            if (text.isBlank()) text = joinElementText(elements);
            if (markdown.isBlank()) markdown = text;

            List<String> warnings = new ArrayList<>();
            if (elements.isEmpty()) warnings.add("OpenDataLoader returned no structured elements");
            return new ParsedDocument(pageCount, normalize(text), normalize(markdown), elements, warnings);
        } finally {
            deleteRecursively(output);
        }
    }

    private void collectElements(JsonNode nodes, List<ParseElement> output, int inheritedPage) {
        if (!nodes.isArray()) return;
        for (JsonNode node : nodes) {
            String type = node.path("type").asText("unknown").toLowerCase(Locale.ROOT);
            int page = node.path("page number").asInt(inheritedPage);
            if (page <= 0) page = inheritedPage;
            if ("table".equals(type)) {
                output.add(new ParseElement(type, page, boundingBox(node.get("bounding box")), null,
                        nullableInt(node, "number of rows"), nullableInt(node, "number of columns"), tableContent(node)));
                continue;
            }
            String content = node.path("content").asText("").strip();
            if (!content.isBlank() || "heading".equals(type) || "caption".equals(type)) {
                output.add(new ParseElement(type, page, boundingBox(node.get("bounding box")),
                        nullableInt(node, "heading level"), null, null, content));
            }
            collectElements(node.path("kids"), output, page);
            collectElements(node.path("list items"), output, page);
        }
    }

    private String tableContent(JsonNode table) {
        List<List<String>> rows = new ArrayList<>();
        for (JsonNode row : table.path("rows")) {
            List<String> cells = new ArrayList<>();
            for (JsonNode cell : row.path("cells")) cells.add(descendantText(cell).strip());
            rows.add(cells);
        }
        if (rows.isEmpty()) return descendantText(table).strip();
        int columns = rows.stream().mapToInt(List::size).max().orElse(0);
        StringBuilder markdown = new StringBuilder();
        for (int rowIndex = 0; rowIndex < rows.size(); rowIndex++) {
            List<String> row = rows.get(rowIndex);
            markdown.append('|');
            for (int column = 0; column < columns; column++) {
                String value = column < row.size() ? row.get(column) : "";
                markdown.append(' ').append(value.replace("|", "\\|").replace('\n', ' ')).append(" |");
            }
            markdown.append('\n');
            if (rowIndex == 0) {
                markdown.append('|').append(" --- |".repeat(Math.max(columns, 1))).append('\n');
            }
        }
        return markdown.toString().strip();
    }

    private String descendantText(JsonNode node) {
        List<String> values = new ArrayList<>();
        collectText(node, values);
        return String.join(" ", values);
    }

    private void collectText(JsonNode node, List<String> output) {
        if (node == null || node.isMissingNode()) return;
        if (node.isObject()) {
            String content = node.path("content").asText("").strip();
            if (!content.isBlank()) output.add(content);
            node.fields().forEachRemaining(entry -> {
                if (!"content".equals(entry.getKey())) collectText(entry.getValue(), output);
            });
        } else if (node.isArray()) {
            node.forEach(item -> collectText(item, output));
        }
    }

    private List<Double> boundingBox(JsonNode value) {
        if (value == null || value.isNull()) return null;
        List<Double> result = new ArrayList<>(4);
        if (value.isArray()) value.forEach(item -> result.add(item.asDouble()));
        else if (value.isObject()) {
            for (String key : List.of("left", "bottom", "right", "top")) {
                if (value.has(key)) result.add(value.path(key).asDouble());
            }
        }
        return result.size() == 4 ? result : null;
    }

    private Integer nullableInt(JsonNode node, String field) {
        return node.has(field) && node.get(field).canConvertToInt() ? node.get(field).asInt() : null;
    }

    private int maxPageNumber(JsonNode node) {
        int maximum = node.path("page number").asInt(0);
        if (node.isContainerNode()) {
            Iterator<JsonNode> children = node.elements();
            while (children.hasNext()) maximum = Math.max(maximum, maxPageNumber(children.next()));
        }
        return maximum;
    }

    private Path requiredOutput(Path output, String extension) throws Exception {
        return findOutput(output, extension).orElseThrow(() -> new IllegalStateException("missing OpenDataLoader " + extension + " output"));
    }

    private String readOptionalOutput(Path output, String extension) throws Exception {
        Optional<Path> path = findOutput(output, extension);
        return path.isPresent() ? Files.readString(path.get(), StandardCharsets.UTF_8) : "";
    }

    private Optional<Path> findOutput(Path output, String extension) throws Exception {
        try (Stream<Path> stream = Files.walk(output)) {
            return stream.filter(Files::isRegularFile)
                    .filter(path -> path.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(extension))
                    .findFirst();
        }
    }

    private String joinElementText(List<ParseElement> elements) {
        return elements.stream().map(ParseElement::content).filter(value -> value != null && !value.isBlank())
                .reduce((left, right) -> left + "\n\n" + right).orElse("");
    }

    private String normalize(String value) {
        return value == null ? "" : value.replace("\r\n", "\n").replace('\r', '\n').strip();
    }

    private void deleteRecursively(Path root) {
        if (root == null || !Files.exists(root)) return;
        try (Stream<Path> paths = Files.walk(root)) {
            paths.sorted(Comparator.reverseOrder()).forEach(path -> {
                try { Files.deleteIfExists(path); } catch (Exception ignored) { }
            });
        } catch (Exception ignored) { }
    }
}
