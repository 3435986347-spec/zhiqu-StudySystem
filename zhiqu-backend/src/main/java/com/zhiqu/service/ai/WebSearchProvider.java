package com.zhiqu.service.ai;

import java.util.List;

public interface WebSearchProvider {
    boolean isAvailable();

    List<SearchResult> search(String query);

    record SearchResult(String title, String url, String snippet, String sourceType, String status) {
        public SearchResult(String title, String url, String snippet) {
            this(title, url, snippet, "SEARCH", "OK");
        }
    }
}
