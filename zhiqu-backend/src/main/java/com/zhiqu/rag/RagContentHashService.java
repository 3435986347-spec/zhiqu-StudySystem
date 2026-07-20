package com.zhiqu.rag;

import com.zhiqu.entity.AiSourceChunk;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Comparator;
import java.util.List;

@Service
public class RagContentHashService {
    private static final String CHUNK_SEPARATOR = "\n\u001e\n";

    public String hashParentChunks(List<AiSourceChunk> chunks) {
        String canonical = chunks.stream()
                .sorted(Comparator.comparing(AiSourceChunk::getChunkIndex))
                .map(chunk -> chunk.getContent() == null ? "" : chunk.getContent())
                .reduce((left, right) -> left + CHUNK_SEPARATOR + right)
                .orElse("");
        if (canonical.isEmpty()) throw new IllegalStateException("Source has no indexable parent chunks");
        return sha256(canonical);
    }

    public String hashChunkTexts(List<String> chunks) {
        if (chunks == null || chunks.isEmpty()) throw new IllegalStateException("Source has no indexable parent chunks");
        return sha256(String.join(CHUNK_SEPARATOR, chunks));
    }

    private String sha256(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder(64);
            for (byte item : digest) result.append(String.format("%02x", item));
            return result.toString();
        } catch (Exception error) {
            throw new IllegalStateException("Unable to calculate source content hash", error);
        }
    }
}
