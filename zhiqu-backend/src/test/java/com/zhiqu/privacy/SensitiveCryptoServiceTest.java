package com.zhiqu.privacy;

import com.zhiqu.common.BusinessException;
import com.zhiqu.common.DecryptFailedException;
import com.zhiqu.service.privacy.SensitiveCryptoService;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 解密失败必须是可按类型捕获的 {@link DecryptFailedException}。
 *
 * <p>批处理路径（RAG 索引 / 记忆迁移 / 摘要压缩）依赖「单行解密失败不拖垮整批」的隔离语义，
 * 而按异常消息字符串识别既脆弱又会误吞。同时它必须仍是 {@link BusinessException} 的子类，
 * 否则既有调用方与 GlobalExceptionHandler 的行为会被悄悄改变。
 */
class SensitiveCryptoServiceTest {

    private static final String MASTER_KEY = "zhiqu-unit-test-master-key-32-chars";

    private final SensitiveCryptoService crypto = new SensitiveCryptoService(MASTER_KEY);

    @Test
    void 密文被别的主密钥加密时抛出可按类型捕获的解密异常() {
        String foreign = new SensitiveCryptoService("a-completely-different-master-key").encrypt("我的长期记忆");

        DecryptFailedException thrown = assertThrows(DecryptFailedException.class, () -> crypto.decrypt(foreign));

        assertInstanceOf(BusinessException.class, thrown,
                "必须仍是 BusinessException 子类，否则既有调用方与全局异常处理的行为会被改变");
        assertEquals("敏感数据解密失败，请检查加密主密钥配置", thrown.getMessage(),
                "面向用户的提示不应因为引入类型而改变");
    }

    @Test
    void 密文损坏时同样抛出解密异常() {
        String cipher = crypto.encrypt("薄弱科目：高数");
        String corrupted = cipher.substring(0, cipher.length() - 4) + "AAAA";

        assertThrows(DecryptFailedException.class, () -> crypto.decrypt(corrupted));
    }

    @Test
    void 正常往返与非密文输入不受影响() {
        String plain = "目标考试：2026 考研数学";
        assertEquals(plain, crypto.decrypt(crypto.encrypt(plain)));

        // 无 v1: 前缀的历史明文原样返回，空值返回空串——这两条既有行为不能因为改异常类型而变
        assertEquals("尚未加密的历史数据", crypto.decrypt("尚未加密的历史数据"));
        assertEquals("", crypto.decrypt(null));
        assertEquals("", crypto.decrypt("   "));
        assertTrue(crypto.isEncrypted(crypto.encrypt(plain)));
    }
}
