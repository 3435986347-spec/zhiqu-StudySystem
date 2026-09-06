package com.zhiqu.pdfeval.model;

import java.util.List;

public record ParsedDocument(
        int pageCount,
        String text,
        String markdown,
        List<ParseElement> elements,
        List<String> warnings
) {
}
