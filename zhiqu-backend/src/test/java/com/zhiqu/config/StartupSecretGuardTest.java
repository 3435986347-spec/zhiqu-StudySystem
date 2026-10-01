package com.zhiqu.config;

import com.zhiqu.config.StartupSecretGuard.Verdict;
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
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 钉住「没换掉的密钥不许启动」。
 *
 * <p>这一批判据存在的理由是一次真实的观察：{@code application-prod.example.yml} 里五个
 * {@code CHANGE_ME_...} 占位符，最短的 21 字符、最长的 44 字符，<b>全部长到足以通过
 * 当时所有的校验</b>。照模板部署、忘了填，服务会干净地起来并用一个公开字符串签发令牌。
 */
class StartupSecretGuardTest {

    private static final Path PROD_TEMPLATE =
            Path.of("..", "deploy", "windows", "application-prod.example.yml");
    private static final Path GUARD_SOURCE =
            Path.of("src", "main", "java", "com", "zhiqu", "config", "StartupSecretGuard.java");

    // ── judge() 三条判定 ───────────────────────────────────────────────

    @Test
    @DisplayName("空与全空白都判 BLANK —— 「键漏了」必须落在拒绝的一侧")
    void 空值判为BLANK() {
        assertEquals(Verdict.BLANK, StartupSecretGuard.judge(null));
        assertEquals(Verdict.BLANK, StartupSecretGuard.judge(""));
        assertEquals(Verdict.BLANK, StartupSecretGuard.judge("   "));
        assertEquals(Verdict.BLANK, StartupSecretGuard.judge("\t\n "));
    }

    @Test
    @DisplayName("CHANGE_ME 开头判 PLACEHOLDER，大小写与前后空白都不影响")
    void 占位符判为PLACEHOLDER() {
        assertEquals(Verdict.PLACEHOLDER, StartupSecretGuard.judge("CHANGE_ME_DB_PASSWORD"));
        assertEquals(Verdict.PLACEHOLDER, StartupSecretGuard.judge("change_me_db_password"));
        assertEquals(Verdict.PLACEHOLDER, StartupSecretGuard.judge("  CHANGE_ME_RAG_SERVICE_TOKEN  "));
    }

    @Test
    @DisplayName("仓库里那两份开发默认值判 SHIPPED_DEFAULT，而随机值判 OK")
    void 开发默认值与正常值() {
        assertEquals(Verdict.SHIPPED_DEFAULT,
                StartupSecretGuard.judge("zhiqu-quadrant-learning-system-secret-key-2024"));
        assertEquals(Verdict.SHIPPED_DEFAULT,
                StartupSecretGuard.judge("zhiqu-dev-master-key-change-in-production-2026"));
        assertEquals(Verdict.OK, StartupSecretGuard.judge("Qw3rT9-x8aB2cD4eF6gH1jK5lM7nP0sU"));
        // 只是「包含」而不是「以之开头」，不算占位符 —— 否则一个随机值里凑巧出现
        // CHANGE_ME 会被误杀。
        assertEquals(Verdict.OK, StartupSecretGuard.judge("x9CHANGE_ME_zz-random-secret-value"));
    }

    // ── 这一批判据的由来：占位符骗过了既有的长度校验 ─────────────────────

    @Test
    @DisplayName("模板里每个占位符都长到能通过 length()<24 那条，所以只靠长度拦不住")
    void 占位符骗得过长度校验() throws IOException {
        Set<String> placeholders = placeholdersInTemplate();
        assertFalse(placeholders.isEmpty(), "模板里一个 CHANGE_ME 都没扫到 —— 扫空了，后面每条断言都会空过");

        int shortEnoughToBeCaught = 0;
        for (String placeholder : placeholders) {
            // SensitiveCryptoService 的既有校验是 length() < 24
            if (placeholder.length() < 24) {
                shortEnoughToBeCaught++;
            }
            // 而无论长短，本守卫都必须判出来
            assertEquals(Verdict.PLACEHOLDER, StartupSecretGuard.judge(placeholder),
                    placeholder + " 没有被判成占位符");
        }
        assertTrue(shortEnoughToBeCaught < placeholders.size(),
                "如果每个占位符都短于 24 字符，既有的长度校验就够了，这个守卫也就没有存在的理由");
    }

    // ── 覆盖面：模板里新增一个密钥，守卫不能漏 ──────────────────────────

    @Test
    @DisplayName("模板里每个 CHANGE_ME 行的配置键，守卫都必须检查")
    void 模板里的每个密钥键都被覆盖() throws IOException {
        Set<String> keys = placeholderKeysInTemplate();
        assertFalse(keys.isEmpty(), "一个带 CHANGE_ME 的键都没解析出来 —— 空扫，这条判据会假绿");
        assertTrue(keys.size() >= 5,
                "模板里应当至少有 5 个待填密钥，只解析出 " + keys.size() + " 个：" + keys);

        String guard = Files.readString(GUARD_SOURCE, StandardCharsets.UTF_8);
        List<String> missing = new ArrayList<>();
        for (String key : keys) {
            if (!guard.contains("\"" + key + "\"")) {
                missing.add(key);
            }
        }
        assertTrue(missing.isEmpty(),
                "这些密钥在生产模板里待填，但 StartupSecretGuard 没有检查它们："
                        + missing + "。漏掉的那个不会有任何症状。");
    }

    // ── 构造器行为：什么该炸、什么只该 WARN ─────────────────────────────

    @Test
    @DisplayName("jwt.secret 为空 → 启动失败")
    void jwt为空必须启动失败() {
        IllegalStateException e = assertThrows(IllegalStateException.class,
                () -> newGuard("", "a-perfectly-fine-master-key-value", "", "", "", ""));
        assertTrue(e.getMessage().contains("jwt.secret"), "报错要点名是哪个键：" + e.getMessage());
    }

    @Test
    @DisplayName("占位符在非生产环境也一律拒绝 —— 没有任何正当运行会用它")
    void 占位符在开发机上也拒绝() {
        IllegalStateException e = assertThrows(IllegalStateException.class,
                () -> newGuard("CHANGE_ME_TO_A_LONG_RANDOM_SECRET_AT_LEAST_32_CHARS",
                        "a-perfectly-fine-master-key-value", "", "", "", ""));
        assertTrue(e.getMessage().contains("jwt.secret"), e.getMessage());
    }

    @Test
    @DisplayName("数据库 / Redis / RAG 口令：空是正当的，占位符不是")
    void 可选口令只拦占位符() {
        // 三个都空 —— 开发机上的正常状态，不能炸
        newGuard("a-real-looking-secret-value-here", "a-perfectly-fine-master-key-value",
                "", "", "", "");

        for (String key : List.of("spring.datasource.password", "spring.data.redis.password",
                "app.rag.service-token")) {
            IllegalStateException e = assertThrows(IllegalStateException.class, () -> newGuard(
                    "a-real-looking-secret-value-here", "a-perfectly-fine-master-key-value",
                    "spring.datasource.password".equals(key) ? "CHANGE_ME_DB_PASSWORD" : "",
                    "spring.data.redis.password".equals(key) ? "CHANGE_ME_REDIS_PASSWORD" : "",
                    "app.rag.service-token".equals(key) ? "CHANGE_ME_RAG_SERVICE_TOKEN" : "",
                    ""));
            assertTrue(e.getMessage().contains(key), key + " 没被拦住：" + e.getMessage());
        }
    }

    @Test
    @DisplayName("开发默认值：生产 profile 下炸，非生产只告警")
    void 开发默认值只在生产下致命() {
        String devJwt = "zhiqu-quadrant-learning-system-secret-key-2024";
        String devKey = "zhiqu-dev-master-key-change-in-production-2026";

        // 非生产：必须能起来，否则每一次 mvn spring-boot:run 都会失败
        newGuard(devJwt, devKey, "", "", "", "");
        newGuard(devJwt, devKey, "", "", "", "dev");

        for (String profile : List.of("prod", "production", "PROD", " prod ", "windows,prod")) {
            IllegalStateException e = assertThrows(IllegalStateException.class,
                    () -> newGuard(devJwt, devKey, "", "", "", profile),
                    "profile=" + profile + " 应当被判成生产");
            assertTrue(e.getMessage().contains("jwt.secret"), e.getMessage());
        }
    }

    @Test
    @DisplayName("报错里不出现密钥本身 —— 启动堆栈会被贴进工单和日志系统")
    void 报错不泄漏密钥原文() {
        String secret = "CHANGE_ME_TO_A_LONG_RANDOM_SECRET_AT_LEAST_32_CHARS";
        String dbPassword = "CHANGE_ME_DB_PASSWORD";
        IllegalStateException e = assertThrows(IllegalStateException.class,
                () -> newGuard(secret, "a-perfectly-fine-master-key-value", dbPassword, "", "", ""));

        String message = e.getMessage();
        assertFalse(message.contains(secret), "报错里出现了 jwt.secret 的完整值：" + message);
        assertFalse(message.contains(dbPassword), "报错里出现了数据库口令的完整值：" + message);
        // 但必须说清是哪两个键
        assertTrue(message.contains("jwt.secret") && message.contains("spring.datasource.password"),
                "报错要同时点名两个出问题的键：" + message);
    }

    // ── 「这是不是生产」只能有一个答案 ──────────────────────────────────

    @Test
    @DisplayName("生产 profile 的名字集合在 src/main/java 里只有一份定义")
    void 生产profile判定只有一份() throws IOException {
        List<Path> sources;
        try (var walk = Files.walk(Path.of("src", "main", "java"))) {
            sources = walk.filter(p -> p.toString().endsWith(".java")).toList();
        }
        assertTrue(sources.size() > 100, "只扫到 " + sources.size() + " 个源文件 —— 扫空了");

        List<String> definers = new ArrayList<>();
        for (Path source : sources) {
            String text = Files.readString(source, StandardCharsets.UTF_8);
            if (text.contains("Set.of(\"prod\", \"production\")")) {
                definers.add(source.getFileName().toString());
            }
        }
        assertEquals(List.of("DeploymentProfiles.java"), definers,
                "「这是不是生产环境」应当只有一个答案；两份迟早会分叉，"
                        + "而分叉的方向总是安全那一侧少认一个 profile 名。实际定义在：" + definers);
    }

    // ── helpers ───────────────────────────────────────────────────────

    private static StartupSecretGuard newGuard(String jwt, String cryptoKey, String dbPassword,
                                               String redisPassword, String ragToken, String profiles) {
        return new StartupSecretGuard(jwt, cryptoKey, dbPassword, redisPassword, ragToken, profiles);
    }

    /** 模板里出现过的占位符值本身。 */
    private static Set<String> placeholdersInTemplate() throws IOException {
        Set<String> found = new LinkedHashSet<>();
        Matcher m = Pattern.compile("CHANGE_ME[A-Za-z0-9_]*")
                .matcher(Files.readString(PROD_TEMPLATE, StandardCharsets.UTF_8));
        while (m.find()) {
            found.add(m.group());
        }
        return found;
    }

    /**
     * 模板里带占位符那些行对应的<b>完整配置键</b>（如 {@code spring.datasource.password}）。
     *
     * <p>YAML 是缩进式的，所以要一路记住各层父键才能还原出点分路径。
     */
    private static Set<String> placeholderKeysInTemplate() throws IOException {
        Set<String> keys = new LinkedHashSet<>();
        List<String> path = new ArrayList<>();
        Pattern entry = Pattern.compile("^(\\s*)([A-Za-z0-9_.-]+):\\s*(.*)$");

        for (String line : Files.readAllLines(PROD_TEMPLATE, StandardCharsets.UTF_8)) {
            if (line.isBlank() || line.strip().startsWith("#")) {
                continue;
            }
            Matcher m = entry.matcher(line);
            if (!m.matches()) {
                continue;
            }
            int depth = m.group(1).length() / 2;
            String name = m.group(2);
            String value = m.group(3).strip();

            while (path.size() > depth) {
                path.remove(path.size() - 1);
            }
            path.add(name);

            if (value.contains("CHANGE_ME")) {
                keys.add(String.join(".", path));
            }
        }
        return keys;
    }
}
