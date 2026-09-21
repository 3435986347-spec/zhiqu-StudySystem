package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.MalformedInputException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 仓库里不许出现真实密钥。
 *
 * <p><b>这条判据是因为已经发生过一次才有的。</b>2026-07-09 的一次提交把服务器那份真实的
 * {@code application-prod.yml} 原样贴进了 {@code deploy/windows/README.md} 当示例：
 * 数据库口令、{@code jwt.secret}、{@code app.crypto.master-key} 三个真值。仓库是**公开**的，
 * 于是这三个值在 GitHub 上公开可读了两个多月，直到 2026-09-22 才被发现。
 *
 * <p>为什么之前没人发现：它读起来完全正常 —— 一段配置示例，出现在部署文档里，
 * 格式和缩进都对。没有任何东西看起来像「密钥泄漏」，因为它本来就该是一段配置。
 * {@code CLAUDE.md} 写着「Never commit real API keys」，但那是一句约定，没有东西执行它。
 *
 * <p>所以这里查的是<b>形状</b>而不是具体的值：文档与配置模板里，敏感键的值只能是占位符、
 * 环境变量引用，或者显然是示例的短串。把某几个已泄漏的值加进黑名单是没用的 ——
 * 下一次泄漏的会是别的值。
 */
class NoCommittedSecretsTest {

    /**
     * 值必须是占位符或环境变量引用的那些键。
     *
     * <p>缩进只能用 {@code [ \t]*}，<b>不能用 {@code \s*}</b>：Java 的 {@code \s} 包含换行，
     * 配上 {@code (?m)^} 之后一个匹配可以从上一行的行首开始、把中间的换行全吃掉，
     * 于是报出来的行号和内容对不上（第一版就把 {@code application.yml} 的一个空 password
     * 报成了「43 个字符的密钥」）。一条报错指错位置的判据，比没有更费时间。
     */
    private static final Pattern SENSITIVE_LINE = Pattern.compile(
            "(?m)^[ \\t]*(password|secret|master-key|api-key|service-token|token)[ \\t]*:[ \\t]*(\\S.*)$");

    /** 一看就不是真密钥的值。 */
    private static boolean looksLikePlaceholder(String value) {
        String v = value.trim().replaceAll("\\s+#.*$", "").trim();
        if (v.isEmpty() || v.equals("\"\"") || v.equals("''")) return true;
        String upper = v.toUpperCase(Locale.ROOT);
        return upper.startsWith("CHANGE_ME")
                || v.startsWith("${")            // 环境变量引用
                || v.startsWith("<") || v.startsWith("your-") || v.startsWith("YOUR_")
                || upper.contains("PLACEHOLDER") || upper.contains("EXAMPLE")
                || upper.contains("XXXX") || upper.contains("填")
                // 开发默认值是有意公开的（见 StartupSecretGuard）；它们自述身份
                || v.startsWith("zhiqu-quadrant-learning-system-secret")
                || v.startsWith("zhiqu-dev-master-key")
                // 演练环境的固定值：它必须在每次演练之间保持不变（不然上一轮写的密文
                // 这一轮解不开），所以不能是随机的。值本身把这件事写在名字里。
                || v.startsWith("drill-fixed-")
                // 短到不可能是真密钥（示例口令、端口号之类）
                || v.length() < 12;
    }

    private static List<Path> scannedFiles() throws IOException {
        List<Path> out = new ArrayList<>();
        for (Path root : List.of(Path.of("..", "deploy"), Path.of("..", "docs"),
                Path.of("src", "main", "resources"))) {
            if (!Files.isDirectory(root)) continue;
            try (var walk = Files.walk(root)) {
                walk.filter(Files::isRegularFile)
                        .filter(p -> {
                            String n = p.toString();
                            return n.endsWith(".md") || n.endsWith(".yml") || n.endsWith(".yaml")
                                    || n.endsWith(".properties") || n.endsWith(".xml")
                                    || n.endsWith(".ps1") || n.endsWith(".sh");
                        })
                        .forEach(out::add);
            }
        }
        return out;
    }

    @Test
    @DisplayName("部署文档与配置模板里，敏感键的值只能是占位符或环境变量引用")
    void 仓库里不许出现真实密钥() throws IOException {
        List<Path> files = scannedFiles();
        // 正下限：扫空了的话下面每一条都会真空通过，而真空绿和干净绿长得一模一样。
        assertTrue(files.size() >= 15,
                "只扫到 " + files.size() + " 个文件 —— 扫空或扫漏了，这条判据什么都没看");

        List<String> offenders = new ArrayList<>();
        int sensitiveLines = 0;
        for (Path file : files) {
            String text;
            try {
                text = Files.readString(file, StandardCharsets.UTF_8);
            } catch (MalformedInputException e) {
                continue;   // 二进制或非 UTF-8，跳过
            }
            Matcher m = SENSITIVE_LINE.matcher(text);
            while (m.find()) {
                sensitiveLines++;
                String value = m.group(2);
                if (!looksLikePlaceholder(value)) {
                    // 报错里**不复述那个值** —— 一条为了防泄漏而存在的判据，
                    // 不能自己把值印进 CI 日志里。只说在哪一行、哪个键。
                    int line = (int) text.substring(0, m.start()).chars().filter(c -> c == '\n').count() + 1;
                    offenders.add(file + ":" + line + " 的 " + m.group(1)
                            + "（" + value.trim().length() + " 个字符）");
                }
            }
        }
        assertTrue(sensitiveLines >= 10,
                "只匹配到 " + sensitiveLines + " 行敏感键 —— 正则多半失配了，判据在空过");

        assertTrue(offenders.isEmpty(),
                "这些地方写着看起来像真密钥的值：\n  " + String.join("\n  ", offenders)
                        + "\n真实密钥只能放在服务器上那份未跟踪的 application-prod.yml 或环境变量里。"
                        + "\n2026-07-09 就是这样把三个真值贴进 deploy/windows/README.md 的 —— "
                        + "仓库公开，它们公开可读了两个多月。");
    }
}
