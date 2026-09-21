package com.zhiqu.service.ai;

import com.zhiqu.common.BusinessException;
import com.zhiqu.entity.AiMessage;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Service
public class WebResearchService {
    private static final Pattern URL_PATTERN = Pattern.compile("https?://\\S+", Pattern.CASE_INSENSITIVE);

    private final WebSearchProvider webSearchProvider;
    private final WebPageFetchProvider webPageFetchProvider;
    private final SearchPlanner searchPlanner;
    private final int maxPages;

    public WebResearchService(WebSearchProvider webSearchProvider,
                              WebPageFetchProvider webPageFetchProvider,
                              SearchPlanner searchPlanner,
                              @Value("${app.ai.web-fetch.max-pages:4}") int maxPages) {
        this.webSearchProvider = webSearchProvider;
        this.webPageFetchProvider = webPageFetchProvider;
        this.searchPlanner = searchPlanner;
        this.maxPages = Math.max(1, Math.min(maxPages, 8));
    }

    public boolean isSearchAvailable() {
        return webSearchProvider.isAvailable();
    }

    public boolean canResearch(String question) {
        return !extractUrls(question).isEmpty() || webSearchProvider.isAvailable();
    }

    public List<WebSearchProvider.SearchResult> research(String question, List<AiMessage> recentMessages) {
        Set<String> urls = extractUrls(question);
        List<WebSearchProvider.SearchResult> results = new ArrayList<>();
        if (!urls.isEmpty()) {
            for (String url : urls) {
                results.add(webPageFetchProvider.fetch(url));
                if (results.size() >= maxPages) {
                    break;
                }
            }
            return results;
        }
        if (!webSearchProvider.isAvailable()) {
            throw new BusinessException("联网搜索需要配置搜索源；如果只想读取网页，请直接在问题里提供 http/https 链接。");
        }
        String query = searchPlanner.buildQuery(question, recentMessages);
        List<WebSearchProvider.SearchResult> searchResults = webSearchProvider.search(query);
        for (WebSearchProvider.SearchResult item : searchResults) {
            if (item.url() == null || item.url().isBlank()) {
                continue;
            }
            results.add(webPageFetchProvider.fetch(item.url()));
            if (results.size() >= maxPages) {
                break;
            }
        }
        return results.isEmpty() ? searchResults : results;
    }

    public WebSearchProvider.SearchResult fetch(String url) {
        return webPageFetchProvider.fetch(url);
    }

    private Set<String> extractUrls(String text) {
        Set<String> urls = new LinkedHashSet<>();
        Matcher matcher = URL_PATTERN.matcher(text == null ? "" : text);
        while (matcher.find()) {
            urls.add(cleanExtractedUrl(matcher.group()));
        }
        return urls;
    }

    private String cleanExtractedUrl(String url) {
        String cleaned = url == null ? "" : url.trim();
        while (!cleaned.isEmpty() && ".,;:!?)>]}'\"，。；：！？）】》、".indexOf(cleaned.charAt(cleaned.length() - 1)) >= 0) {
            cleaned = cleaned.substring(0, cleaned.length() - 1);
        }
        return cleaned;
    }
}
