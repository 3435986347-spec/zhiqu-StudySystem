package com.zhiqu.desktop;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.yaml.snakeyaml.Yaml;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 桌面 profile 必须把每一个「相对路径的目录配置」覆盖成绝对路径。
 *
 * <p>由来（2026-09-23）：桌面应用从 Finder / Dock 启动时工作目录是 {@code /}
 * （实测 {@code user.dir=/}）。{@code app.private-upload-dir} 默认是相对的
 * {@code private-uploads}，于是解析成只读的 {@code /private-uploads}，每一次写原件都失败 ——
 * 而失败被吞掉了。用户 ⌘V 贴一张图，界面写着「已附到下一条消息」，模型却说看不到，
 * 资料区下载是空的。服务器上没有这个问题：那边是从部署目录启动的，相对路径碰巧对。
 *
 * <p>键名单<b>不手写</b>：从代码里所有 {@code @Value("${app.*-dir:<相对默认值>}")}
 * 和 {@code application.yml} 里 {@code app.*-dir} 的相对值扫出来。第一版修的时候
 * 只改了 {@code upload-dir}（头像用的那个），贴图走的却是 {@code private-upload-dir} ——
 * 手写的名单正好会漏掉这种「以为是同一个」的键。
 */
class DesktopUploadDirTest {

    private static final Path MAIN_JAVA = Path.of("src", "main", "java");
    private static final Path RESOURCES = Path.of("src", "main", "resources");

    /** {@code @Value("${app.xxx-dir:default}")}：键名与默认值。 */
    private static final Pattern VALUE_DIR =
            Pattern.compile("@Value\\(\"\\$\\{app\\.([a-z0-9.-]*-dir):([^}]*)}\"\\)");

    @Test
    @DisplayName("桌面 profile 覆盖了每一个相对路径的 app.*-dir，且覆盖值是绝对路径")
    void 相对目录在桌面版必须改成绝对路径() throws IOException {
        Map<String, String> relativeKeys = relativeDirKeys();

        // 扫空就是真空绿：一个键都没扫到时，下面的循环什么也不检查。
        // 至少有 upload-dir（头像 / 分享计划）和 private-upload-dir（AI 资料原件）两个。
        assertTrue(relativeKeys.size() >= 2,
                "只扫到 " + relativeKeys.keySet() + " —— 扫描规则失效了，判据什么也没看");

        Map<String, Object> desktopApp = appSection(RESOURCES.resolve("application-desktop.yml"));
        StringBuilder problems = new StringBuilder();
        for (Map.Entry<String, String> e : relativeKeys.entrySet()) {
            Object override = desktopApp.get(e.getKey());
            if (override == null) {
                problems.append("\n  app.").append(e.getKey()).append(" 没有覆盖（默认值 ")
                        .append(e.getValue()).append(" 在桌面版会解析到 /").append(e.getValue()).append("）");
                continue;
            }
            String v = override.toString();
            if (!(v.startsWith("${user.home}") || Paths.get(v).isAbsolute())) {
                problems.append("\n  app.").append(e.getKey()).append(" = ").append(v).append(" 仍是相对路径");
            }
        }
        assertTrue(problems.length() == 0,
                "application-desktop.yml 里有目录配置会解析到工作目录 / 下（只读）：" + problems
                        + "\n写原件会全部失败 —— 2026-09-23 的「贴图显示已附上，模型却看不到」就是这样来的。");
    }

    /** 代码默认值与 application.yml 里所有相对的 app.*-dir。 */
    private static Map<String, String> relativeDirKeys() throws IOException {
        Map<String, String> keys = new TreeMap<>();
        try (Stream<Path> files = Files.walk(MAIN_JAVA)) {
            for (Path f : (Iterable<Path>) files.filter(p -> p.toString().endsWith(".java"))::iterator) {
                Matcher m = VALUE_DIR.matcher(Files.readString(f, StandardCharsets.UTF_8));
                while (m.find()) {
                    if (isRelative(m.group(2))) {
                        keys.put(m.group(1), m.group(2));
                    }
                }
            }
        }
        for (Map.Entry<String, Object> e : appSection(RESOURCES.resolve("application.yml")).entrySet()) {
            if (e.getKey().endsWith("-dir") && e.getValue() != null && isRelative(e.getValue().toString())) {
                keys.put(e.getKey(), e.getValue().toString());
            }
        }
        return keys;
    }

    private static boolean isRelative(String value) {
        String v = value.trim();
        return !v.isEmpty() && !v.startsWith("${") && !Paths.get(v).isAbsolute();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> appSection(Path yml) throws IOException {
        Map<String, Object> root = new Yaml().load(Files.readString(yml, StandardCharsets.UTF_8));
        Object app = root == null ? null : root.get("app");
        return app instanceof Map ? (Map<String, Object>) app : Map.of();
    }
}
