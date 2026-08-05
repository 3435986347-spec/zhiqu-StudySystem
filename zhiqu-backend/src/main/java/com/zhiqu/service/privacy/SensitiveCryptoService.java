package com.zhiqu.service.privacy;

import com.zhiqu.common.BusinessException;
import com.zhiqu.common.DecryptFailedException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

@Service
public class SensitiveCryptoService {
    private static final String PREFIX = "v1:";
    private static final int GCM_TAG_BITS = 128;
    private static final int IV_BYTES = 12;

    private final SecureRandom secureRandom = new SecureRandom();
    private final SecretKeySpec keySpec;

    public SensitiveCryptoService(@Value("${app.crypto.master-key}") String masterKey) {
        if (masterKey == null || masterKey.isBlank() || masterKey.length() < 24) {
            throw new IllegalStateException("app.crypto.master-key must be configured and at least 24 characters");
        }
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(masterKey.getBytes(StandardCharsets.UTF_8));
            this.keySpec = new SecretKeySpec(digest, "AES");
        } catch (Exception e) {
            throw new IllegalStateException("Failed to initialize crypto service", e);
        }
    }

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
            throw new BusinessException("敏感数据加密失败");
        }
    }

    public String decrypt(String cipherText) {
        if (cipherText == null || cipherText.isBlank()) {
            return "";
        }
        if (!cipherText.startsWith(PREFIX)) {
            return cipherText;
        }
        try {
            String[] parts = cipherText.split(":", 3);
            byte[] iv = Base64.getDecoder().decode(parts[1]);
            byte[] encrypted = Base64.getDecoder().decode(parts[2]);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, keySpec, new GCMParameterSpec(GCM_TAG_BITS, iv));
            return new String(cipher.doFinal(encrypted), StandardCharsets.UTF_8);
        } catch (Exception e) {
            // 类型化而非仅靠消息串：批处理路径（RAG 索引 / 记忆迁移 / 摘要压缩）需要按类型
            // 捕获它，把单行失败隔离成 SKIPPED 并继续，而不是让一行坏数据拖垮整批。
            throw new DecryptFailedException("敏感数据解密失败，请检查加密主密钥配置");
        }
    }

    public boolean isEncrypted(String value) {
        return value != null && value.startsWith(PREFIX);
    }

    public String maskSecret(String value) {
        if (value == null || value.isBlank()) {
            return "";
        }
        String plain = isEncrypted(value) ? decrypt(value) : value;
        if (plain.length() <= 8) {
            return plain.charAt(0) + "****";
        }
        return plain.substring(0, Math.min(6, plain.length())) + "****" + plain.substring(plain.length() - 4);
    }

    public String sha256Hex(String value) {
        if (value == null) {
            value = "";
        }
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : digest) {
                sb.append(String.format("%02x", b));
            }
            return sb.toString();
        } catch (Exception e) {
            throw new BusinessException("摘要计算失败");
        }
    }
}
