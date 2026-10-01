package com.zhiqu.pdfeval.runner;

import com.zhiqu.pdfeval.model.ParsedDocument;

import java.nio.file.Path;

@FunctionalInterface
public interface DocumentParser {
    ParsedDocument parse(Path input, int maxPages) throws Exception;
}
