package com.zhiqu.config;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 生产配置模板必须包含 {@code application.yml} 里的每一个键。
 *
 * <p>生产由 {@code --spring.config.location=file:./application-prod.yml} 拉起，它是<b>替换</b>而不是追加 ——
 * JAR 里的 application.yml 线上一个字都不读。模板漏抄一个键，那一项在生产就静默回到 Spring 的默认值：
 * 比如漏了 {@code spring.servlet.multipart.max-file-size}，开发机上 20MB 能传，线上 1MB 以上全失败，
 * 而报错像是网络问题。2026-09-25 对照过一遍，两边此刻一致；这条判据让它们一直一致。
 */
class ProdConfigParityTest {

    private static final Path DEV = Path.of("src/main/resources/application.yml");
    private static final Path PROD = Path.of("..", "deploy", "windows", "application-prod.example.yml");
    private static final Pattern KEY = Pattern.compile("^(\\s*)([A-Za-z0-9_.\\-\\[\\]\"]+):(.*)$");

    /** 有值的叶子键，点号连起来（例如 {@code spring.servlet.multipart.max-file-size}）。列表项与注释不算。 */
    static Set<String> leafKeys(String yaml) {
        Set<String> keys = new TreeSet<>();
        Deque<Object[]> stack = new ArrayDeque<>();
        for (String raw : yaml.split("\n")) {
            if (raw.stripLeading().startsWith("#") || raw.isBlank() || raw.stripLeading().startsWith("- ")) {
                continue;
            }
            String line = raw.replaceAll("\\s+#.*$", "");
            Matcher m = KEY.matcher(line);
            if (!m.matches()) {
                continue;
            }
            int indent = m.group(1).length();
            while (!stack.isEmpty() && (int) stack.peekLast()[0] >= indent) {
                stack.pollLast();
            }
            stack.addLast(new Object[]{indent, m.group(2).replace("\"", "")});
            String rest = m.group(3).trim();
            if (!rest.isEmpty() && !rest.startsWith("|") && !rest.startsWith(">")) {
                StringBuilder key = new StringBuilder();
                for (Object[] part : stack) {
                    key.append(key.length() == 0 ? "" : ".").append(part[1]);
                }
                keys.add(key.toString());
            }
        }
        return keys;
    }

    @Test
    @DisplayName("application.yml 里的每个键，生产模板里都要有（生产配置是替换不是追加，漏一个就静默回到 Spring 默认值）")
    void 生产模板不漏键() throws Exception {
        Set<String> dev = leafKeys(Files.readString(DEV));
        Set<String> prod = leafKeys(Files.readString(PROD));
        assertTrue(dev.size() >= 40 && prod.size() >= 40, "解析出的键太少，判据在空转：dev=" + dev.size() + " prod=" + prod.size());
        assertTrue(dev.contains("spring.servlet.multipart.max-file-size"), "解析器没认出嵌套的键：" + dev);
        Set<String> missing = new TreeSet<>(dev);
        missing.removeAll(prod);
        assertTrue(missing.isEmpty(), "生产模板里漏了这些键，线上会静默用 Spring 的默认值：" + missing);
    }
}
