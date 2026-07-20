package com.zhiqu.rag;

import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.net.InetAddress;
import java.net.URI;
import java.util.LinkedHashMap;
import java.util.Map;

@Component
public class RagClient {
    private final RagProperties properties;
    private final RestClient client;

    public RagClient(RagProperties properties) {
        this.properties = properties;
        validateBaseUrl(properties.getBaseUrl());
        SimpleClientHttpRequestFactory requestFactory = new SimpleClientHttpRequestFactory();
        requestFactory.setConnectTimeout(properties.getConnectTimeoutMs());
        requestFactory.setReadTimeout(properties.getReadTimeoutMs());
        this.client = RestClient.builder()
                .baseUrl(properties.getBaseUrl())
                .requestFactory(requestFactory)
                .defaultHeader(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE)
                .build();
    }

    public boolean configured() {
        return properties.isEnabled() && properties.getServiceToken() != null
                && !properties.getServiceToken().isBlank();
    }

    public Map<String, Object> meta() {
        if (!configured()) {
            return Map.of("ready", false, "reason", "DISABLED_OR_TOKEN_MISSING");
        }
        try {
            Map<String, Object> body = get("/v1/meta");
            Map<String, Object> result = new LinkedHashMap<>(body);
            result.putIfAbsent("ready", true);
            return result;
        } catch (Exception e) {
            return Map.of("ready", false, "reason", safeMessage(e));
        }
    }

    public Map<String, Object> query(Map<String, Object> body) {
        return post("/v1/query", body);
    }

    public Map<String, Object> indexSource(Map<String, Object> body) {
        return post("/v1/index/sources", body);
    }

    public Map<String, Object> deleteIndex(Map<String, Object> body) {
        return post("/v1/index/delete", body);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> get(String path) {
        return client.get().uri(path)
                .header(HttpHeaders.AUTHORIZATION, bearer())
                .retrieve().body(Map.class);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> post(String path, Map<String, Object> body) {
        if (!configured()) {
            throw new IllegalStateException("RAG service is disabled or its token is missing");
        }
        Map<String, Object> result = client.post().uri(path)
                .header(HttpHeaders.AUTHORIZATION, bearer())
                .contentType(MediaType.APPLICATION_JSON)
                .body(body)
                .retrieve().body(Map.class);
        return result == null ? Map.of() : result;
    }

    private String bearer() {
        return "Bearer " + properties.getServiceToken();
    }

    private static void validateBaseUrl(String raw) {
        try {
            URI uri = URI.create(raw);
            if (!"http".equalsIgnoreCase(uri.getScheme()) && !"https".equalsIgnoreCase(uri.getScheme())) {
                throw new IllegalArgumentException("RAG base URL must use http or https");
            }
            InetAddress address = InetAddress.getByName(uri.getHost());
            if (!address.isLoopbackAddress()) {
                throw new IllegalArgumentException("P0 RAG sidecar must listen on loopback only");
            }
        } catch (IllegalArgumentException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalArgumentException("Invalid RAG base URL", e);
        }
    }

    private static String safeMessage(Exception e) {
        String message = e.getMessage();
        return message == null || message.isBlank() ? e.getClass().getSimpleName() : message;
    }
}
