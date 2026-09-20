package com.zhiqu.service.privacy;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 密钥脱敏 —— <b>此前零覆盖，而它在短密钥上等于不脱敏</b>。
 *
 * <h2>旧实现漏了什么</h2>
 *
 * <p>{@code plain.substring(0, min(6, len)) + "****" + plain.substring(len - 4)}：
 * 前 6 位与后 4 位在长度 9 / 10 时<b>重叠</b>，整个密钥都出现在输出里。实测
 * {@code "0123456789"} → {@code "012345****6789"} —— 10 个字符一个不剩，
 * 只是中间插了个 {@code ****}，看上去像脱敏过了。
 *
 * <h2>判据怎么写才不会被骗</h2>
 *
 * <p>比「输出等于某个字符串」会把判据钉死在格式上。这里比的是<b>输出里到底泄露了原文的
 * 多少</b>：把 {@code ****} 去掉之后剩下的字符，必须是原文的一小部分。
 * 这样换一种掩码写法不会红，而「掩码里能拼出原文」一定红。
 */
class SecretMaskTest {

    /** 主密钥只是构造前提（要求 ≥24 字符）；本类测的是脱敏，不碰加解密。 */
    private static SensitiveCryptoService service() {
        return new SensitiveCryptoService("0123456789abcdef0123456789abcdef");
    }

    /** 掩码里泄露了原文的几个字符（去掉 {@code ****} 之后剩下的长度）。 */
    private static int revealed(String masked) {
        return masked.replace(SensitiveCryptoService.MASK, "").length();
    }

    /**
     * 短密钥一个字符都不能露。
     *
     * <p>扰动：把 {@code MIN_MASKABLE_LENGTH} 那条下界去掉 → 本条红。
     */
    @Test
    void 短密钥不得露出任何字符() {
        SensitiveCryptoService crypto = service();
        for (String key : new String[]{"a", "abc", "12345678", "123456789", "0123456789", "01234567890"}) {
            String masked = crypto.maskSecret(key);
            assertEquals(0, revealed(masked),
                    "长度 " + key.length() + " 的密钥不得露出任何字符，实际掩码是「" + masked
                            + "」—— 旧实现在长度 9/10 上前后两段重叠，把整个密钥都露了出来");
        }
    }

    /**
     * 长密钥最多只露末尾几位，而且掩码里<b>拼不出</b>原文的开头。
     *
     * <p>扰动：把前缀也拼进去（回到旧写法）→ 本条红。
     */
    @Test
    void 长密钥最多只露末尾几位() {
        SensitiveCryptoService crypto = service();
        String key = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
        String masked = crypto.maskSecret(key);

        assertTrue(revealed(masked) <= 4,
                "最多只该露 4 个字符，实际露了 " + revealed(masked) + " 个：「" + masked + "」");
        assertFalse(masked.contains("sk-proj"),
                "掩码里不得出现密钥的开头 —— 那是能用来定位/猜测这把 key 的部分。实际：" + masked);
        assertTrue(masked.endsWith("6789"),
                "末 4 位要保留，用户得能认出这是哪一把 key。实际：" + masked);
    }

    /**
     * 掩码不得随原文长度泄露过多 —— 对每个长度都验一遍比例。
     *
     * <p>这条是上面两条的推广：任意长度下，泄露的字符数都不得超过原文的一半。
     */
    @Test
    void 任意长度下泄露都不得超过一半() {
        SensitiveCryptoService crypto = service();
        StringBuilder key = new StringBuilder();
        int checked = 0;
        for (int length = 1; length <= 60; length++) {
            key.append((char) ('a' + length % 26));
            String masked = crypto.maskSecret(key.toString());
            checked++;
            assertTrue(revealed(masked) * 2 <= length,
                    "长度 " + length + " 时露了 " + revealed(masked) + " 个字符（掩码「" + masked
                            + "」），超过一半");
        }
        assertEquals(60, checked, "下界：必须真的把 1..60 每个长度都验过");
    }

    /** 空值与空白：返回空串，不抛异常，也不返回掩码（那会让界面显示成「配过一把 key」）。 */
    @Test
    void 空密钥返回空串() {
        SensitiveCryptoService crypto = service();
        assertEquals("", crypto.maskSecret(null));
        assertEquals("", crypto.maskSecret("   "));
    }

    /**
     * {@code isMasked} 必须认得出自己生成的掩码。
     *
     * <p>写入端靠它判断「客户端把展示值原样回传了，意思是别改这把 key」。
     * 此前那里写的是 {@code endsWith("****")}，而旧掩码结尾是真实字符，<b>判不出来</b> ——
     * 于是那道防护对长密钥（也就是绝大多数真 key）完全不起作用。
     *
     * <p>扰动：把 {@code isMasked} 改回 {@code endsWith(MASK)} → 本条红。
     */
    @Test
    void 生成的掩码必须被识别为掩码() {
        SensitiveCryptoService crypto = service();
        for (String key : new String[]{"abc", "0123456789",
                "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"}) {
            String masked = crypto.maskSecret(key);
            assertTrue(crypto.isMasked(masked),
                    "长度 " + key.length() + " 的掩码「" + masked + "」必须被认出来，"
                            + "否则它会被当成一把新 key 加密存进去，真 key 就没了");
        }
        assertFalse(crypto.isMasked("sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"),
                "反例：真 key 不得被误判成掩码，否则用户改不了 key 而且没有任何提示");
        assertFalse(crypto.isMasked(null));
    }
}
