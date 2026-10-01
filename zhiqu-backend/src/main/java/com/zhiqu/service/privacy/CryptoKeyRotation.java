package com.zhiqu.service.privacy;

import java.util.List;
import java.util.Optional;

/**
 * 主密钥轮换的<b>纯逻辑</b> —— 不碰数据库、不碰 Spring，只回答「这一格该怎么处理」。
 *
 * <p>拆成纯函数是为了让最要紧的那条判定能被判据直接喂对抗性输入，而不必立起数据库：
 * <b>一格密文用旧 key、新 key 都解不开时，是硬停而不是跳过。</b>跳过会把不可读的数据
 * 留在库里、且没有任何信号；那可能是密文损坏，也可能是它其实由第三把 key 加密
 * （有人轮换过、或配错了旧 key）—— 无论哪种，都必须让操作者停下来查，而不是继续。
 */
public final class CryptoKeyRotation {

    /** 一格值轮换后的去向。 */
    public enum Outcome {
        /** 空值，无需处理。 */
        EMPTY,
        /** 明文透传（非 v1: 前缀），轮换不碰它 —— 换 key 不改变「它是明文」这件事。 */
        PLAINTEXT,
        /** 旧 key 解开了，已用新 key 重新加密。 */
        ROTATED,
        /** 新 key 就能解开，说明上一次（可能中断的）轮换已经处理过它，幂等跳过。 */
        ALREADY_NEW,
        /** 两把 key 都解不开 —— 硬停。 */
        UNDECRYPTABLE
    }

    /** 一格的处理结果：去向，以及（仅 ROTATED 时）要写回的新密文。 */
    public record CellResult(Outcome outcome, String newCipher) {
        static CellResult of(Outcome outcome) {
            return new CellResult(outcome, null);
        }
    }

    private final AesGcmCipher oldCipher;
    private final AesGcmCipher newCipher;

    public CryptoKeyRotation(AesGcmCipher oldCipher, AesGcmCipher newCipher) {
        this.oldCipher = oldCipher;
        this.newCipher = newCipher;
    }

    /**
     * 决定一格值怎么处理。<b>先试新 key</b>：这样重入时已经轮换过的行走
     * {@link Outcome#ALREADY_NEW} 直接跳过，不会被再加密一层。
     */
    public CellResult classify(String value) {
        if (value == null || value.isBlank()) {
            return CellResult.of(Outcome.EMPTY);
        }
        if (!AesGcmCipher.isCipherText(value)) {
            return CellResult.of(Outcome.PLAINTEXT);
        }
        // 先试新 key —— 幂等：重入时已处理的行在这里就被认出来
        if (newCipher.tryDecryptCipher(value).isPresent()) {
            return CellResult.of(Outcome.ALREADY_NEW);
        }
        Optional<String> underOld = oldCipher.tryDecryptCipher(value);
        if (underOld.isPresent()) {
            return new CellResult(Outcome.ROTATED, newCipher.encrypt(underOld.get()));
        }
        return CellResult.of(Outcome.UNDECRYPTABLE);
    }

    /** 一张表的哪些列要轮换。 */
    public record TableSpec(String table, String idColumn, List<String> encryptedColumns) {
        public TableSpec(String table, String... encryptedColumns) {
            this(table, "id", List.of(encryptedColumns));
        }
    }

    /**
     * 全部要轮换的列。<b>手写的清单，会漏</b> —— 新加一个 {@code encrypted*} 列忘了登记，
     * 那列数据轮换后就静默不可读。{@code CryptoKeyRotationCoverageTest} 扫 entity 里
     * 每个 {@code encrypted*} 字段反查这份清单，漏一个就红。
     */
    public static final List<TableSpec> TABLES = List.of(
            new TableSpec("study_task", "encrypted_title", "encrypted_description"),
            new TableSpec("ai_conversation", "encrypted_summary"),
            new TableSpec("ai_model_config", "encrypted_api_key"),
            new TableSpec("device_push_token", "encrypted_token"),
            new TableSpec("knowledge_source", "encrypted_content"),
            new TableSpec("user_knowledge_page", "encrypted_content"),
            new TableSpec("user_knowledge_revision", "encrypted_content"),
            new TableSpec("user_ai_memory", "encrypted_memory_text")
    );
}
