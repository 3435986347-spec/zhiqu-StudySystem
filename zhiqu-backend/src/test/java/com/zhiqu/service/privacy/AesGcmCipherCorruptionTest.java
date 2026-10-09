package com.zhiqu.service.privacy;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 坏掉的密文只有一种失败方式：{@link AesGcmCipher.AesDecryptException}。批处理（RAG 索引、记忆迁移、摘要压缩）
 * 按这个类型把单行失败隔离成 SKIPPED；换成别的异常，一页坏数据就会让整批中断。
 */
class AesGcmCipherCorruptionTest {

    private final AesGcmCipher cipher = new AesGcmCipher("0123456789abcdef0123456789abcdef");

    @Test
    @DisplayName("各种坏法（比标签还短、Base64 坏了、段数不对、被篡改、另一把 key 加的）都是 AesDecryptException")
    void 都收敛成一种异常() {
        String good = cipher.encrypt("只有本人能看到的正文");
        String[] parts = good.split(":", 3);
        String tampered = parts[0] + ":" + parts[1] + ":" + (parts[2].charAt(0) == 'A' ? 'B' : 'A') + parts[2].substring(1);
        List<String> broken = List.of(
                "v1:Zm9v:YmFy",                 // 比 GCM 标签还短：17.0.20 上是 ProviderException
                "v1:!!!:###",                   // Base64 坏了：IllegalArgumentException
                "v1:Zm9v",                      // 段数不对
                tampered,                       // 被改过：AEADBadTagException
                new AesGcmCipher("another-key-another-key-0123").encrypt("x"));
        for (String bad : broken) {
            assertThrows(AesGcmCipher.AesDecryptException.class, () -> cipher.decrypt(bad), bad);
        }
        assertEquals("只有本人能看到的正文", cipher.decrypt(good));
        assertTrue(cipher.tryDecryptCipher("v1:Zm9v:YmFy").isEmpty());
    }
}
