package com.zhiqu.pdfeval.pdfbox;

import com.zhiqu.pdfeval.model.ParseElement;
import com.zhiqu.pdfeval.model.ParsedDocument;
import com.zhiqu.pdfeval.runner.DocumentParser;
import org.apache.pdfbox.Loader;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

public final class PdfBoxParser implements DocumentParser {
    @Override
    public ParsedDocument parse(Path input, int maxPages) throws Exception {
        try (PDDocument document = Loader.loadPDF(Files.readAllBytes(input))) {
            if (document.isEncrypted()) throw new IllegalArgumentException("encrypted PDF is not supported");
            int pageCount = document.getNumberOfPages();
            if (pageCount > maxPages) throw new IllegalArgumentException("PDF exceeds maxPages=" + maxPages);
            PDFTextStripper stripper = new PDFTextStripper();
            StringBuilder text = new StringBuilder();
            List<ParseElement> elements = new ArrayList<>();
            List<String> warnings = new ArrayList<>();
            for (int page = 1; page <= pageCount; page++) {
                stripper.setStartPage(page);
                stripper.setEndPage(page);
                String pageText = normalizeLineEndings(stripper.getText(document)).strip();
                if (pageText.isBlank()) warnings.add("page " + page + " has no selectable text");
                else elements.add(new ParseElement("paragraph", page, null, null, null, null, pageText));
                if (page > 1) text.append("\n\n");
                text.append(pageText);
            }
            return new ParsedDocument(pageCount, text.toString(), text.toString(), elements, warnings);
        }
    }

    private String normalizeLineEndings(String value) {
        return value == null ? "" : value.replace("\r\n", "\n").replace('\r', '\n');
    }
}
