package com.zhiqu.pdfeval.model;

import java.util.List;

public record ParseResult(
        String requestId,
        String engine,
        String version,
        String fileHash,
        int pageCount,
        String text,
        String markdown,
        List<ParseElement> elements,
        long elapsedMs,
        long peakRssBytes,
        List<String> warnings,
        String error,
        boolean truncated,
        boolean needsOcr
) {
}
