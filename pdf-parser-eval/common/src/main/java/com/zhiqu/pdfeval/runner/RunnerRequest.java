package com.zhiqu.pdfeval.runner;

public record RunnerRequest(String requestId, String input, Integer maxPages,
                            Integer maxOutputChars, Long maxFileBytes) {
    public int resolvedMaxPages() {
        return maxPages == null || maxPages <= 0 ? 200 : maxPages;
    }

    public int resolvedMaxOutputChars() {
        return maxOutputChars == null || maxOutputChars <= 0 ? 500_000 : maxOutputChars;
    }

    public long resolvedMaxFileBytes() {
        return maxFileBytes == null || maxFileBytes <= 0 ? 20L * 1024 * 1024 : maxFileBytes;
    }
}
