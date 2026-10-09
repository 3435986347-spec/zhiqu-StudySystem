package com.zhiqu.service.privacy;

import org.springframework.beans.factory.InitializingBean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 主密钥哨兵（第二十八轮）：这个进程的加密主密钥和库里的数据是不是同一把。不是就<b>不启动</b>。
 *
 * <p>用户 2026-10-04 说明：桌面应用和网页端都连服务器上的同一个 MySQL。好几个后端写同一个库，主密钥必须一样 ——
 * 不一样的那个进程解不开别人写的密文（任务标题、Wiki 正文、模型 Key），它写进去的别人也解不开。桌面应用原来恰好就不一样：
 * 它没有覆盖主密钥，用的是仓库里的开发默认值。这种错不报错，只是数据一格一格地变成谁都读不出来的东西，所以宁可起不来。
 *
 * <p>为什么在 bean 初始化时判、而不是 ApplicationRunner：runner 在 Tomcat 开始接请求之后才跑，那中间来的请求已经能写密文了。
 * 这个 bean 依赖 JdbcTemplate，Spring Boot 让它排在数据库迁移之后（表已经建好），而又在服务开始接请求之前。
 */
@Component
public class CryptoKeyCanary implements InitializingBean {

    static final String PLAINTEXT = "zhiqu-crypto-canary-v1";
    /** 库里还没有哨兵时，每一列抽几格已有的密文来核。 */
    static final int SAMPLES_PER_COLUMN = 3;
    static final String MISMATCH = "这台机器的加密主密钥（app.crypto.master-key）和这个数据库里的数据不是同一把。"
            + "连同一个库的所有后端（服务器、每台电脑上的桌面应用）必须配同一把主密钥 —— 桌面应用在 ~/.zhiqu/application.yml 里配，"
            + "和服务器的 application-prod.yml 里那一行一样。为了不把库里的数据写坏，这次不启动。";

    private final JdbcTemplate jdbc;
    private final SensitiveCryptoService crypto;

    public CryptoKeyCanary(JdbcTemplate jdbc, SensitiveCryptoService crypto) {
        this.jdbc = jdbc;
        this.crypto = crypto;
    }

    @Override
    public void afterPropertiesSet() {
        verify(jdbc, crypto);
    }

    /**
     * 核一遍；不对就抛（启动失败）。库里还没有哨兵时：先抽查已有的密文 —— 一格都解不开就拒绝、也<b>不写</b>哨兵
     * （否则一个配错主密钥的实例先启动，哨兵就成了错的那把，配对了的服务器反而起不来）；全空的新库或解得开，才写。
     * 两个实例同时写：`INSERT IGNORE` 以先写进去的为准，写完再读回来核一次。
     */
    static void verify(JdbcTemplate jdbc, SensitiveCryptoService crypto) {
        String canary = read(jdbc);
        if (canary == null) {
            int[] sample = sampleExisting(jdbc, crypto);
            if (sample[0] > 0 && sample[1] == 0) {
                throw new IllegalStateException(MISMATCH + "（库里已经有别的实例写的数据：抽了 " + sample[0] + " 格密文，一格都解不开）");
            }
            jdbc.update("INSERT IGNORE INTO crypto_canary(id, encrypted_value) VALUES (1, ?)", crypto.encrypt(PLAINTEXT));
            canary = read(jdbc);
        }
        if (!opens(crypto, canary)) {
            throw new IllegalStateException(MISMATCH);
        }
    }

    private static String read(JdbcTemplate jdbc) {
        List<String> rows = jdbc.queryForList("SELECT encrypted_value FROM crypto_canary WHERE id = 1", String.class);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private static boolean opens(SensitiveCryptoService crypto, String cipherText) {
        try {
            return cipherText != null && crypto.isEncrypted(cipherText) && PLAINTEXT.equals(crypto.decrypt(cipherText));
        } catch (RuntimeException e) {
            return false;
        }
    }

    /** @return [抽到的密文格数, 解得开的格数]。只算真是密文的格子（旧数据里可能还有没加密的明文，那些谁都「解得开」）。 */
    static int[] sampleExisting(JdbcTemplate jdbc, SensitiveCryptoService crypto) {
        int tried = 0;
        int ok = 0;
        for (CryptoKeyRotation.TableSpec spec : CryptoKeyRotation.TABLES) {
            if ("crypto_canary".equals(spec.table())) {
                continue;
            }
            for (String column : spec.encryptedColumns()) {
                List<String> values = jdbc.queryForList("SELECT " + column + " FROM " + spec.table()
                        + " WHERE " + column + " IS NOT NULL AND " + column + " <> '' LIMIT " + (SAMPLES_PER_COLUMN * 4), String.class);
                int taken = 0;
                for (String value : values) {
                    if (taken >= SAMPLES_PER_COLUMN || !crypto.isEncrypted(value)) {
                        continue;
                    }
                    taken++;
                    tried++;
                    try {
                        crypto.decrypt(value);
                        ok++;
                    } catch (RuntimeException e) {
                        // 这一格解不开：可能是主密钥不对，也可能是一格坏数据。只有一格都解不开才算主密钥不对
                    }
                }
            }
        }
        return new int[]{tried, ok};
    }
}
