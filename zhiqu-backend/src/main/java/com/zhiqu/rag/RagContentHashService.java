package com.zhiqu.rag;

import com.zhiqu.entity.AiSourceChunk;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Comparator;
import java.util.List;

@Service
public class RagContentHashService {
    /**
     * 父块拼接分隔符（U+001E 记录分隔符，正文里几乎不可能自然出现）。
     *
     * <p>转为 public 是因为 {@link CanonicalText} 必须用同一个值 —— 它参与哈希，
     * 两处取值不同就等于同一份资料有两个哈希，每次 reconcile 都判定「内容变了」、无限重建。
     * <b>改动它会让全部存量 content_hash 失效并触发一次全量重建</b>，不要随手调整。
     */
    public static final String CHUNK_SEPARATOR = "\n\u001e\n";

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

    /**
     * 规范化全文的哈希。投影表的 {@code canonical_hash} 与业务钩子必须都走这里 ——
     * 两处各写一份 sha256 的后果不是编译错误，是同一份内容算出两个值、单元被无限重建。
     */
    public String hashCanonicalText(String canonicalText) {
        return sha256(canonicalText == null ? "" : canonicalText);
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
