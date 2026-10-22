package com.zhiqu.service.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.client.RestTemplate;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Service
public class TavilySearchProvider implements WebSearchProvider {
    private final RestTemplate restTemplate = new RestTemplate();
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final String apiKey;
    private final String provider;
    private final String endpoint;
    private final int maxResults;

    public TavilySearchProvider(@Value("${app.ai.web-search.api-key:}") String apiKey,
                                @Value("${app.ai.web-search.provider:tavily}") String provider,
                                @Value("${app.ai.web-search.endpoint:}") String endpoint,
                                @Value("${app.ai.web-search.max-results:5}") int maxResults) {
        this.apiKey = apiKey == null ? "" : apiKey.trim();
        this.provider = provider == null ? "tavily" : provider.trim().toLowerCase();
        this.endpoint = endpoint == null ? "" : endpoint.trim();
        this.maxResults = Math.max(1, Math.min(8, maxResults));
    }

    @Override
    public boolean isAvailable() {
        if ("none".equals(provider)) {
            return false;
        }
        if ("searxng".equals(provider)) {
            return !endpoint.isBlank();
        }
        return !apiKey.isBlank();
    }

    @Override
    public List<SearchResult> search(String query) {
        if (!isAvailable()) {
            throw new BusinessException("联网搜索未配置，请先在生产配置中设置 Tavily API Key");
        }
        if (query == null || query.trim().isBlank()) {
            return List.of();
        }
        try {
            if ("searxng".equals(provider)) {
                return searchSearxng(query.trim());
            }
            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("api_key", apiKey);
            body.put("query", query.trim());
            body.put("search_depth", "basic");
            body.put("max_results", maxResults);
            body.put("include_answer", false);
            body.put("include_raw_content", false);

            ResponseEntity<String> response = restTemplate.postForEntity(
                    "https://api.tavily.com/search",
                    new HttpEntity<>(body, headers),
                    String.class
            );
            JsonNode root = objectMapper.readTree(response.getBody());
            JsonNode results = root.path("results");
            if (!results.isArray()) {
                return List.of();
            }
            List<SearchResult> items = new ArrayList<>();
            for (JsonNode item : results) {
                String url = text(item.path("url"));
                if (!isHttpUrl(url)) {
                    continue;
                }
                items.add(new SearchResult(
                        limit(text(item.path("title")), 120),
                        url,
                        limit(firstText(item.path("content"), item.path("snippet")), 500),
                        "TAVILY",
                        "OK"
                ));
                if (items.size() >= maxResults) {
                    break;
                }
            }
            return items;
        } catch (RestClientResponseException e) {
            throw new BusinessException("联网搜索失败（HTTP " + e.getStatusCode().value() + "）");
        } catch (Exception e) {
            throw new BusinessException("联网搜索失败：" + e.getMessage());
        }
    }

    private List<SearchResult> searchSearxng(String query) throws Exception {
        String base = endpoint.endsWith("/") ? endpoint.substring(0, endpoint.length() - 1) : endpoint;
        String separator = base.contains("?") ? "&" : "?";
        String url = base + separator + "q=" + URLEncoder.encode(query, StandardCharsets.UTF_8) + "&format=json";
        ResponseEntity<String> response = restTemplate.getForEntity(url, String.class);
        JsonNode root = objectMapper.readTree(response.getBody());
        JsonNode results = root.path("results");
        if (!results.isArray()) {
            return List.of();
        }
        List<SearchResult> items = new ArrayList<>();
        for (JsonNode item : results) {
            String itemUrl = text(item.path("url"));
            if (!isHttpUrl(itemUrl)) {
                continue;
            }
            items.add(new SearchResult(
                    limit(text(item.path("title")), 120),
                    itemUrl,
                    limit(firstText(item.path("content"), item.path("snippet")), 500),
                    "SEARXNG",
                    "OK"
            ));
            if (items.size() >= maxResults) {
                break;
            }
        }
        return items;
    }

    private String firstText(JsonNode first, JsonNode second) {
        String value = text(first);
        return value.isBlank() ? text(second) : value;
    }

    private String text(JsonNode node) {
        return node == null || node.isMissingNode() || node.isNull() ? "" : node.asText("").trim();
    }

    private String limit(String value, int max) {
        if (value == null) {
            return "";
        }
        String text = value.replaceAll("\\s+", " ").trim();
        return text.length() <= max ? text : text.substring(0, max) + "...";
    }

    private boolean isHttpUrl(String value) {
        String url = value == null ? "" : value.trim().toLowerCase();
        return url.startsWith("https://") || url.startsWith("http://");
    }
}
