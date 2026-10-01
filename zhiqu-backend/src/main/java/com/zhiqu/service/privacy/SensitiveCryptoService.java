package com.zhiqu.service.privacy;

import com.zhiqu.common.BusinessException;
import com.zhiqu.common.DecryptFailedException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

@Service
public class SensitiveCryptoService {

    /**
     * 加解密本身住在 {@link AesGcmCipher}（派生 + 格式的唯一定义）；这个类保留脱敏、
     * 掩码识别、SHA-256 等只对「展示 / 存储决策」有意义的逻辑，以及类型化的解密异常。
     */
    private final AesGcmCipher cipher;

    public SensitiveCryptoService(@Value("${app.crypto.master-key}") String masterKey) {
        if (masterKey == null || masterKey.isBlank() || masterKey.length() < 24) {
            throw new IllegalStateException("app.crypto.master-key must be configured and at least 24 characters");
        }
        this.cipher = new AesGcmCipher(masterKey);
    }

    public String encrypt(String plainText) {
        return cipher.encrypt(plainText);
    }

    public String decrypt(String cipherText) {
        try {
            return cipher.decrypt(cipherText);
        } catch (AesGcmCipher.AesDecryptException e) {
            // 类型化而非仅靠消息串：批处理路径（RAG 索引 / 记忆迁移 / 摘要压缩）需要按类型
            // 捕获它，把单行失败隔离成 SKIPPED 并继续，而不是让一行坏数据拖垮整批。
            throw new DecryptFailedException("敏感数据解密失败，请检查加密主密钥配置");
        }
    }

    public boolean isEncrypted(String value) {
        return AesGcmCipher.isCipherText(value);
    }

    /** 掩码标记 —— 生成与识别共用同一个常量，两边各写一遍迟早会对不上。 */
    public static final String MASK = "****";

    /** 尾部保留的位数：够用户认出「是哪一把 key」，又不足以拼出它。 */
    private static final int VISIBLE_TAIL = 4;

    /**
     * 短于它就一个字符都不露。取 12：露 4 位时至少还藏着 8 位。
     *
     * <p>没有这条下界的话，短密钥会被<b>整个</b>露出来 —— 见下面的历史。
     */
    private static final int MIN_MASKABLE_LENGTH = 12;

    /**
     * 把密钥脱敏成可以展示的样子。
     *
     * <h2>此前它在短密钥上等于不脱敏</h2>
     *
     * <p>旧实现是 {@code plain.substring(0, min(6, len)) + "****" + plain.substring(len - 4)}：
     * 前 6 位与后 4 位在长度 9 / 10 时<b>重叠</b>，于是整个密钥都出现在输出里，只是中间插了个
     * {@code ****}。实测：{@code "0123456789"} → {@code "012345****6789"}，10 个字符一个不剩。
     * 长度 11 露 10 个，长度 12 露 10 个。
     *
     * <p>长密钥也露得过多：44 位的 OpenAI key 会露出首 6 位与末 4 位共 10 个字符。
     * 展示的目的只是「让用户认出这是哪一把」，末 4 位就够了。
     *
     * <p>调试指向本地 mock 时填一把短 key（本仓库明确支持这种用法）是很自然的，
     * 而那正是旧实现把它原样显示出来的区间。
     */
    public String maskSecret(String value) {
        if (value == null || value.isBlank()) {
            return "";
        }
        String plain = isEncrypted(value) ? decrypt(value) : value;
        if (plain.length() < MIN_MASKABLE_LENGTH) {
            return MASK;
        }
        return MASK + plain.substring(plain.length() - VISIBLE_TAIL);
    }

    /**
     * 这个值是不是<b>本服务生成的掩码</b>（而不是一把真 key）。
     *
     * <p>写入端据此判断「客户端把展示值原样回传了，意思是别改」。此前那里写的是
     * {@code apiKey.endsWith("****")} —— 而旧掩码的结尾是真实的后 4 位，<b>判不出来</b>；
     * 只有 8 位以下的短 key 才碰巧以 {@code ****} 结尾。判定规则收在这里，
     * 与生成规则放在一起，免得两边再次分叉。
     */
    public boolean isMasked(String value) {
        return value != null && value.startsWith(MASK);
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
