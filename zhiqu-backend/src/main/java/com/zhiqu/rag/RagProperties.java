package com.zhiqu.rag;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Data
@Component
@ConfigurationProperties(prefix = "app.rag")
public class RagProperties {
    private boolean enabled = false;
    private String baseUrl = "http://127.0.0.1:8001";
    private String serviceToken = "";
    private int connectTimeoutMs = 300;
    private int readTimeoutMs = 1800;
    private int candidateK = 24;
    private int finalK = 8;
    private int maxContextChars = 10000;
    private int maxPerSource = 3;
    private int maxSnippetChars = 1600;
    private boolean fallbackEnabled = true;
    private String indexVersion = "bge-small-zh-v1.5@pinned-token448-overlap64-v1-cosine";
    private int workerBatchSize = 4;
    private int maxAttempts = 8;
}
