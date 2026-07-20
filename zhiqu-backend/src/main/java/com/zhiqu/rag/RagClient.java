package com.zhiqu.rag;

import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import java.io.InputStream;
import java.net.InetAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
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
                .retrieve()
                // 409 有两种语义，必须分开处理，否则会把「已被更新操作取代」误判成故障并一路重试到 DEAD：
                //   STALE_MUTATION          墓碑拒绝陈旧写入 —— 预期结果，作业应转终态
                //   INDEX_VERSION_MISMATCH  索引版本错配   —— 配置问题，仍按普通错误上报
                .onStatus(status -> status.value() == 409, (request, response) -> {
                    String detail = readBody(response);
                    if (isIndexVersionMismatch(detail)) {
                        throw new IllegalStateException("RAG sidecar index version mismatch: " + detail);
                    }
                    throw new StaleMutationException(detail);
                })
                .body(Map.class);
        return result == null ? Map.of() : result;
    }

    private static String readBody(ClientHttpResponse response) {
        try (InputStream in = response.getBody()) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }

    /**
     * 兼容两种 sidecar：新版在 detail 里给出机器可读的 code，旧版只有人类可读文案。
     * 只有能明确判定为版本错配时才当作普通错误；其余 409 一律按陈旧写入处理。
     */
    private static boolean isIndexVersionMismatch(String detail) {
        if (detail == null) return false;
        return detail.contains("INDEX_VERSION_MISMATCH") || detail.contains("Index version mismatch");
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
