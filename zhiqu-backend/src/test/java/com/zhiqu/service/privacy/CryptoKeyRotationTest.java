package com.zhiqu.service.privacy;

import com.zhiqu.service.privacy.CryptoKeyRotation.CellResult;
import com.zhiqu.service.privacy.CryptoKeyRotation.Outcome;
import com.zhiqu.service.privacy.CryptoKeyRotation.TableSpec;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 主密钥轮换的纯逻辑判据。
 *
 * <p>最要紧的一条是「两把 key 都解不开 → {@link Outcome#UNDECRYPTABLE}」：轮换时那一格
 * <b>不能被跳过</b>，因为跳过会把不可读的数据留在库里且没有任何信号。
 */
class CryptoKeyRotationTest {

    private static final String OLD = "old-master-key-0123456789abcdef";
    private static final String NEW = "new-master-key-fedcba9876543210";
    private static final String THIRD = "some-third-key-never-configured-xyz";

    private final AesGcmCipher oldC = new AesGcmCipher(OLD);
    private final AesGcmCipher newC = new AesGcmCipher(NEW);
    private final CryptoKeyRotation rotation = new CryptoKeyRotation(oldC, newC);

    @Test
    @DisplayName("旧 key 的密文被认出、用新 key 重新加密，且内容一字不差")
    void 旧密文被轮换到新key() {
        String cipherOld = oldC.encrypt("我的 OpenAI Key sk-abc");
        CellResult r = rotation.classify(cipherOld);

        assertEquals(Outcome.ROTATED, r.outcome());
        assertNotNull(r.newCipher(), "轮换必须给出要写回的新密文");
        assertTrue(AesGcmCipher.isCipherText(r.newCipher()));
        // 新密文只有新 key 解得开，且明文与原来一致
        assertEquals("我的 OpenAI Key sk-abc", newC.decrypt(r.newCipher()));
        assertTrue(oldC.tryDecryptCipher(r.newCipher()).isEmpty(),
                "轮换后的密文不该还能被旧 key 解开");
    }

    @Test
    @DisplayName("已经是新 key 的密文幂等跳过 —— 重入不会叠加密一层")
    void 已是新key的幂等跳过() {
        String cipherNew = newC.encrypt("已经轮换过了");
        CellResult r = rotation.classify(cipherNew);
        assertEquals(Outcome.ALREADY_NEW, r.outcome());
        assertNull(r.newCipher(), "已是新 key 的行不该产生写回");
    }

    @Test
    @DisplayName("两把 key 都解不开 → UNDECRYPTABLE（硬停），绝不当成跳过")
    void 两把key都解不开是硬停() {
        // 用一把从未配置过的第三方 key 加密 —— 模拟「旧 key 给错了」或「密文来自更早一次轮换」
        String foreign = new AesGcmCipher(THIRD).encrypt("谁也解不开");
        CellResult r = rotation.classify(foreign);
        assertEquals(Outcome.UNDECRYPTABLE, r.outcome(),
                "解不开的密文必须是硬停信号，不能悄悄跳过 —— 那会留下无人知晓的不可读数据");
        assertNull(r.newCipher());
    }

    @Test
    @DisplayName("损坏的密文（截断 / 乱改）也判 UNDECRYPTABLE")
    void 损坏密文判硬停() {
        String cipherOld = oldC.encrypt("原文");
        String corrupted = cipherOld.substring(0, cipherOld.length() - 4) + "XXXX";
        assertEquals(Outcome.UNDECRYPTABLE, rotation.classify(corrupted).outcome());
    }

    @Test
    @DisplayName("明文透传（非 v1:）不碰它 —— 换 key 不改变「它是明文」")
    void 明文透传原样保留() {
        assertEquals(Outcome.PLAINTEXT, rotation.classify("这是一段历史明文标题").outcome());
        assertEquals(Outcome.PLAINTEXT, rotation.classify("sk-plaintext-legacy").outcome());
    }

    @Test
    @DisplayName("空 / null / 全空白 → EMPTY，无需处理")
    void 空值() {
        assertEquals(Outcome.EMPTY, rotation.classify(null).outcome());
        assertEquals(Outcome.EMPTY, rotation.classify("").outcome());
        assertEquals(Outcome.EMPTY, rotation.classify("   ").outcome());
    }

    @Test
    @DisplayName("先试新 key 再试旧 key —— 顺序保证幂等")
    void 分类顺序保证幂等() throws IOException {
        // 这条防的是「把顺序写反」：先试旧 key 的话，一段恰好能被旧 key 解开的
        // 已轮换密文……其实不会发生（新密文旧 key 解不开）。真正的风险在实现里 ——
        // 断言源码确实先试新 key。
        String src = Files.readString(
                Path.of("src", "main", "java", "com", "zhiqu", "service", "privacy", "CryptoKeyRotation.java"),
                StandardCharsets.UTF_8);
        int newIdx = src.indexOf("newCipher.tryDecryptCipher");
        int oldIdx = src.indexOf("oldCipher.tryDecryptCipher");
        assertTrue(newIdx > 0 && oldIdx > 0, "两处解密尝试都要在 —— 判据扫空了");
        assertTrue(newIdx < oldIdx,
                "必须先试新 key 再试旧 key，否则重入的幂等性没有保证");
    }

    // ── 覆盖面：新加一个 encrypted 列忘了登记，就是静默数据损坏 ──────────

    @Test
    @DisplayName("每个 entity 里的 encrypted* 列都必须出现在轮换清单里")
    void 轮换清单必须覆盖所有加密列() throws IOException {
        Path entityDir = Path.of("src", "main", "java", "com", "zhiqu", "entity");
        Set<String> declaredColumns = new LinkedHashSet<>();

        List<Path> entities;
        try (var walk = Files.walk(entityDir)) {
            entities = walk.filter(p -> p.toString().endsWith(".java")).toList();
        }
        assertTrue(entities.size() > 15, "只扫到 " + entities.size() + " 个 entity —— 扫空了");

        // private String encryptedXxx;  →  encrypted_xxx
        Pattern field = Pattern.compile("private\\s+String\\s+(encrypted[A-Za-z0-9]+)\\s*;");
        for (Path entity : entities) {
            Matcher m = field.matcher(Files.readString(entity, StandardCharsets.UTF_8));
            while (m.find()) {
                declaredColumns.add(camelToSnake(m.group(1)));
            }
        }
        assertTrue(declaredColumns.size() >= 7,
                "只解析出 " + declaredColumns.size() + " 个加密列 —— 正则多半失配了：" + declaredColumns);

        Set<String> covered = new LinkedHashSet<>();
        for (TableSpec spec : CryptoKeyRotation.TABLES) {
            covered.addAll(spec.encryptedColumns());
        }

        List<String> missing = new ArrayList<>();
        for (String col : declaredColumns) {
            if (!covered.contains(col)) {
                missing.add(col);
            }
        }
        assertTrue(missing.isEmpty(),
                "这些加密列存在于 entity 里，但轮换清单 CryptoKeyRotation.TABLES 没登记："
                        + missing + "。轮换会跳过它们 —— 那列数据换 key 后静默不可读。");
    }

    private static String camelToSnake(String camel) {
        StringBuilder sb = new StringBuilder();
        for (char c : camel.toCharArray()) {
            if (Character.isUpperCase(c)) {
                sb.append('_').append(Character.toLowerCase(c));
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }
}
