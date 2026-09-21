package com.zhiqu.pdfeval.model;

import java.util.List;

public record ParseElement(
        String type,
        int page,
        List<Double> boundingBox,
        Integer headingLevel,
        Integer tableRows,
        Integer tableColumns,
        String content
) {
}
