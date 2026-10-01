package com.zhiqu.config;

import com.zhiqu.common.DeploymentProfiles;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * 启动期拒绝<b>没有被换掉的密钥</b>。
 *
 * <p>为什么需要它：生产服务由 {@code deploy/windows/zhiqu-backend.xml} 用
 * {@code --spring.config.location=file:./application-prod.yml} 拉起，而这个参数是
 * <b>替换</b>而不是追加 —— JAR 里那份 {@code application.yml} 在线上根本不会被读。
 * 所以线上唯一现实的失手方式就是：照 {@code application-prod.example.yml} 抄一份，
 * 有几行 {@code CHANGE_ME_...} 忘了填。
 *
 * <p>而这种失手<b>不会有任何症状</b>。两个占位符都长得足够体面：
 * {@code CHANGE_ME_TO_A_LONG_RANDOM_CRYPTO_MASTER_KEY} 有 44 个字符，
 * {@code SensitiveCryptoService} 那条 {@code length() < 24} 拦不住它；
 * {@code jwt.secret} 那一侧则本来就一条校验都没有。服务会干干净净地起来、
 * 正常发登录令牌、正常加解密 —— 只是那把签名用的钥匙是公开在仓库里的一个字符串，
 * 任何读过这个仓库的人都能伪造任意用户的登录态。没有报错、没有告警、没有日志。
 *
 * <p>三条判定，理由各不相同：
 * <ul>
 *   <li><b>空</b> —— 一律拒绝。这一条是给「漏掉了整个键」准备的：
 *       {@code spring.config.location} 换掉配置位置之后，漏掉的键不会回落到开发默认值，
 *       它就是空的。「没配」必须落在拒绝的一侧。</li>
 *   <li><b>占位符</b>（{@code CHANGE_ME} 开头）—— 一律拒绝，开发机上也拒绝。
 *       没有任何一种正当运行会用这个值，所以这一条不可能误伤。</li>
 *   <li><b>仓库里那份开发默认值</b> —— 只在生产 profile 下拒绝，其余时候 WARN。
 *       本地开发正当地用着它，一律拒绝会让每一次 {@code mvn spring-boot:run} 都起不来。</li>
 * </ul>
 *
 * <p>数据库口令、Redis 口令与 RAG token 只走「占位符」这一条：开发环境下它们空着是正当
 * 配置（{@code application.yml} 里前两行就是空的，RAG 更是整个可选），把空判成致命会误伤。
 *
 * <p>覆盖哪些键不靠记性：{@code StartupSecretGuardTest} 扫
 * {@code application-prod.example.yml} 里每一个 {@code CHANGE_ME} 行，断言对应的键在这个类里
 * 出现过。写这个类的时候就漏了 {@code app.rag.service-token} —— 五个里漏一个，
 * 而漏掉的那个不会有任何症状。
 *
 * <p><b>报错里不会出现密钥本身</b>，只说是哪个配置键、犯了哪一条。启动失败的堆栈
 * 常常会被贴进工单、聊天窗口或者日志收集系统 —— 一条为了防泄漏而存在的守卫，
 * 不能自己成为泄漏的渠道。
 */
@Component
public class StartupSecretGuard {

    private static final Logger log = LoggerFactory.getLogger(StartupSecretGuard.class);

    /** 占位符前缀。{@code application-prod.example.yml} 里所有待填项都以它开头。 */
    static final String PLACEHOLDER_PREFIX = "CHANGE_ME";

    /**
     * 仓库里公开可见的开发默认值。
     *
     * <p>这两个字符串<b>本来就该在仓库里</b> —— 它们是开发默认值，不是泄漏。
     * 危险的不是它们被人看见，是它们跑在了生产上。
     */
    static final Set<String> SHIPPED_DEV_SECRETS = Set.of(
            "zhiqu-quadrant-learning-system-secret-key-2024",
            "zhiqu-dev-master-key-change-in-production-2026");

    /** 一个配置值的判定结果。 */
    enum Verdict {
        /** 可以用。 */
        OK,
        /** 空或全空白 —— 键漏了。 */
        BLANK,
        /** 还是 {@code CHANGE_ME_...}，模板没填。 */
        PLACEHOLDER,
        /** 就是仓库里那份开发默认值。 */
        SHIPPED_DEFAULT
    }

    public StartupSecretGuard(@Value("${jwt.secret:}") String jwtSecret,
                              @Value("${app.crypto.master-key:}") String cryptoMasterKey,
                              @Value("${spring.datasource.password:}") String datasourcePassword,
                              @Value("${spring.data.redis.password:}") String redisPassword,
                              @Value("${app.rag.service-token:}") String ragServiceToken,
                              @Value("${spring.profiles.active:}") String activeProfiles) {
        boolean production = DeploymentProfiles.isProduction(activeProfiles);
        List<String> fatal = new ArrayList<>();
        List<String> warnings = new ArrayList<>();

        collect("jwt.secret", jwtSecret, true, production, fatal, warnings);
        collect("app.crypto.master-key", cryptoMasterKey, true, production, fatal, warnings);
        collect("spring.datasource.password", datasourcePassword, false, production, fatal, warnings);
        collect("spring.data.redis.password", redisPassword, false, production, fatal, warnings);
        collect("app.rag.service-token", ragServiceToken, false, production, fatal, warnings);

        warnings.forEach(log::warn);
        if (!fatal.isEmpty()) {
            throw new IllegalStateException(String.join("\n", fatal)
                    + "\n填写办法见 deploy/windows/README.md 的「密钥怎么生成、怎么轮换」一节。");
        }
    }

    private static void collect(String key,
                                String value,
                                boolean blankIsFatal,
                                boolean production,
                                List<String> fatal,
                                List<String> warnings) {
        Verdict verdict = judge(value);
        switch (verdict) {
            case BLANK -> {
                if (blankIsFatal) {
                    fatal.add("配置项 " + key + " 是空的。它签发登录令牌 / 加解密敏感字段，不能留空。");
                }
            }
            case PLACEHOLDER -> fatal.add("配置项 " + key + " 还是 " + PLACEHOLDER_PREFIX
                    + " 占位符 —— application-prod.yml 是照模板抄的，这一行忘了填。");
            case SHIPPED_DEFAULT -> {
                String text = "配置项 " + key + " 用的是仓库里那份开发默认值。"
                        + "这个字符串公开在代码仓库里，任何人都能读到它。";
                if (production) {
                    fatal.add(text + " 生产环境必须换成随机值。");
                } else {
                    warnings.add(text + " 本地开发可以，但部署前务必换掉。");
                }
            }
            case OK -> {
            }
        }
    }

    /**
     * 判定单个配置值 —— <b>纯函数</b>，判据直接调它，不用起 Spring 上下文。
     *
     * <p>占位符比对忽略大小写：模板里写的是大写，但操作员手抄时大小写走样是常事，
     * 而一个「小写的占位符」显然也没被填过。
     */
    static Verdict judge(String value) {
        if (value == null || value.isBlank()) {
            return Verdict.BLANK;
        }
        String trimmed = value.trim();
        if (trimmed.toUpperCase(Locale.ROOT).startsWith(PLACEHOLDER_PREFIX)) {
            return Verdict.PLACEHOLDER;
        }
        if (SHIPPED_DEV_SECRETS.contains(trimmed)) {
            return Verdict.SHIPPED_DEFAULT;
        }
        return Verdict.OK;
    }
}
