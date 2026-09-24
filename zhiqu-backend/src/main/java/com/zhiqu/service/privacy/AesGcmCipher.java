package com.zhiqu.service.privacy;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Optional;

/**
 * 一把 AES-GCM 密钥，以及它的加解密与线上格式 —— <b>唯一定义</b>。
 *
 * <p>抽出来是因为主密钥轮换需要**同时**握两把 key（用旧 key 解、用新 key 加）。
 * 把「怎么从口令派生出 AES 密钥」「密文长什么样」这两件事各写一遍的话，
 * {@code SensitiveCryptoService} 与轮换工具迟早分叉 —— 而分叉产生的乱码不会在写入时报错，
 * 只在某天用另一把 key 解密时才炸，那时已经无从追溯是哪次写坏的。
 *
 * <p>密钥派生是 {@code SHA-256(口令)}，密文是 {@code v1:<base64 IV>:<base64 密文>}。
 * 不以 {@code v1:} 开头的值一律视为<b>明文透传</b>（加密能力上线前的历史数据）。
 */
public final class AesGcmCipher {

    static final String PREFIX = "v1:";
    private static final int GCM_TAG_BITS = 128;
    private static final int IV_BYTES = 12;

    private final SecureRandom secureRandom = new SecureRandom();
    private final SecretKeySpec keySpec;

    /** 从口令派生。派生方式（SHA-256）只在这里出现一次。 */
    public AesGcmCipher(String passphrase) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(passphrase.getBytes(StandardCharsets.UTF_8));
            this.keySpec = new SecretKeySpec(digest, "AES");
        } catch (Exception e) {
            throw new IllegalStateException("无法初始化加密密钥", e);
        }
    }

    /** 一段值是不是本格式的密文（而不是明文透传）。 */
    public static boolean isCipherText(String value) {
        return value != null && value.startsWith(PREFIX);
    }

    /** 加密。null / 空白返回 null（与既有 {@code encrypt} 语义一致）。 */
    public String encrypt(String plainText) {
        if (plainText == null || plainText.isBlank()) {
            return null;
        }
        try {
            byte[] iv = new byte[IV_BYTES];
            secureRandom.nextBytes(iv);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, keySpec, new GCMParameterSpec(GCM_TAG_BITS, iv));
            byte[] encrypted = cipher.doFinal(plainText.getBytes(StandardCharsets.UTF_8));
            return PREFIX
                    + Base64.getEncoder().encodeToString(iv)
                    + ":"
                    + Base64.getEncoder().encodeToString(encrypted);
        } catch (Exception e) {
            throw new IllegalStateException("敏感数据加密失败", e);
        }
    }

    /**
     * 解密。抛异常表示<b>这把 key 解不开</b>（口令不符、密文损坏或截断）。
     *
     * <p>非 {@code v1:} 前缀的值原样返回 —— 明文透传。
     */
    public String decrypt(String cipherText) {
        if (cipherText == null || cipherText.isBlank()) {
            return "";
        }
        if (!isCipherText(cipherText)) {
            return cipherText;
        }
        try {
            String[] parts = cipherText.split(":", 3);   // 段数不对时下一行越界，由下面统一收成 AesDecryptException
            byte[] iv = Base64.getDecoder().decode(parts[1]);
            byte[] encrypted = Base64.getDecoder().decode(parts[2]);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, keySpec, new GCMParameterSpec(GCM_TAG_BITS, iv));
            return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
        } catch (Exception e) {
            // 「这个值解不开」只有一种说法。key 不符是 AEADBadTagException；密文被截断 / 损坏时各个 JDK 抛的不一样 ——
            // 17.0.20 上短于 GCM 标签的密文抛 ProviderException（ShortBufferException），Base64 坏了是
            // IllegalArgumentException。原来这里把运行时异常原样放行，于是一页坏数据能让 RAG 整批索引中断
            // （RagUnitRegistryIntegrationTest.坏密文只跳过该页而不拖垮整批 —— 这条判据在 2026-09-24 第一次
            // 真正开着 Docker 跑时才红出来）。AesGcmCipherCorruptionTest 在不要 Docker 的地方钉着这件事。
            throw new AesDecryptException("敏感数据解密失败");
        }
    }

    /**
     * 「用这把 key 能不能解开」—— 解得开返回明文，解不开返回空。
     *
     * <p>轮换工具靠它<b>不抛异常地</b>依次试两把 key：GCM 是认证加密，用错的 key 解密
     * 必然失败，所以「哪把 key 加的」是可以判定的，这正是轮换可重入、可崩溃恢复的根据。
     * 明文透传值（非 {@code v1:}）在这里返回空 —— 它不是密文，不该被当成「某把 key 解开了」。
     */
    public Optional<String> tryDecryptCipher(String cipherText) {
        if (!isCipherText(cipherText)) {
            return Optional.empty();
        }
        try {
            return Optional.of(decrypt(cipherText));
        } catch (RuntimeException e) {
            return Optional.empty();
        }
    }

    /** key 不符或密文损坏。收敛 GCM 的受检异常，让调用方能按类型处理。 */
    public static final class AesDecryptException extends RuntimeException {
        public AesDecryptException(String message) {
            super(message);
        }
    }
}
