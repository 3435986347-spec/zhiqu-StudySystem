package com.zhiqu.service.desktop;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 桌面版的安装包（第八十二轮）：网页版里「下载桌面版」从这里拿。
 *
 * <p>安装包放在服务器上的一个目录里（{@code app.desktop-downloads-dir}，默认 {@code downloads}，相对后端的工作目录），
 * 不进 git、不进 JAR：dmg 一百多 MB，GitHub 单个文件上限 100MB；打进 JAR 的话桌面包里装着这个 JAR，等于安装包里再装一份安装包。
 *
 * <p>每个平台取目录里最新的那一个（按修改时间）：macOS 认 {@code .dmg}，Windows 认 {@code .exe / .msi / .zip}。
 * 文件名从来不从请求里来 —— 请求只能说平台名，所以路径绕不出这个目录；符号链接、子目录一律不认。
 */
@Service
public class DesktopDownloads {

    /** 平台：下载地址里的名字、认哪些扩展名、浏览器拿到时的类型。 */
    public enum Platform {
        MACOS("macos", List.of("dmg"), "application/x-apple-diskimage"),
        WINDOWS("windows", List.of("exe", "msi", "zip"), "application/octet-stream");

        public final String key;
        final List<String> extensions;
        public final String contentType;

        Platform(String key, List<String> extensions, String contentType) {
            this.key = key;
            this.extensions = extensions;
            this.contentType = contentType;
        }

        /** 地址里的平台名 → 平台；认不出的回空（接口回 404，不去目录里找）。 */
        public static Optional<Platform> of(String key) {
            for (Platform p : values()) if (p.key.equalsIgnoreCase(key == null ? "" : key.trim())) return Optional.of(p);
            return Optional.empty();
        }

        boolean accepts(String fileName) {
            String lower = fileName.toLowerCase(Locale.ROOT);
            return extensions.stream().anyMatch(ext -> lower.endsWith("." + ext));
        }
    }

    /** 一个安装包。version 从文件名里认（「知趣象限-1.0.0.dmg」→ 1.0.0），认不出是 null。 */
    public record Installer(Platform platform, Path path, String fileName, long size, String version, String sha256, FileTime modified) {
        public Map<String, Object> view() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("platform", platform.key);
            out.put("fileName", fileName);
            out.put("size", size);
            out.put("version", version);
            out.put("sha256", sha256);
            out.put("url", "/api/desktop/downloads/" + platform.key);
            return out;
        }
    }

    private static final Pattern VERSION = Pattern.compile("(\\d+\\.\\d+\\.\\d+)");

    private final Path dir;
    /** SHA-256 按「路径 + 大小 + 修改时间」记住：一百多 MB 的文件不能每次列表都算一遍。 */
    private final Map<String, String> digests = new ConcurrentHashMap<>();

    public DesktopDownloads(@Value("${app.desktop-downloads-dir:downloads}") String dir) {
        this.dir = Path.of(dir).toAbsolutePath().normalize();
    }

    public Path dir() {
        return dir;
    }

    /** 这个平台最新的安装包；目录不存在、没有这种文件都是空。 */
    public Optional<Installer> latest(Platform platform) {
        if (!Files.isDirectory(dir, LinkOption.NOFOLLOW_LINKS)) return Optional.empty();
        Path best = null;
        FileTime bestTime = null;
        try (DirectoryStream<Path> files = Files.newDirectoryStream(dir)) {
            for (Path file : files) {
                String name = file.getFileName().toString();
                if (name.startsWith(".") || !platform.accepts(name)) continue;
                if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) continue;   // 符号链接、目录不认
                FileTime time = Files.getLastModifiedTime(file, LinkOption.NOFOLLOW_LINKS);
                if (best == null || time.compareTo(bestTime) > 0) { best = file; bestTime = time; }
            }
        } catch (IOException e) {
            return Optional.empty();
        }
        if (best == null) return Optional.empty();
        try {
            long size = Files.size(best);
            String name = best.getFileName().toString();
            Matcher v = VERSION.matcher(name);
            return Optional.of(new Installer(platform, best, name, size, v.find() ? v.group(1) : null, sha256(best, size, bestTime), bestTime));
        } catch (IOException e) {
            return Optional.empty();
        }
    }

    /** 各平台有没有安装包：{ macos: {...} 或 null, windows: {...} 或 null } —— 没有的照实给 null，前端说「还在准备」。 */
    public Map<String, Object> listing() {
        Map<String, Object> out = new LinkedHashMap<>();
        for (Platform p : Platform.values()) out.put(p.key, latest(p).map(Installer::view).orElse(null));
        return out;
    }

    private String sha256(Path file, long size, FileTime modified) throws IOException {
        String key = file + "|" + size + "|" + modified.toMillis();
        String hit = digests.get(key);
        if (hit != null) return hit;
        MessageDigest md;
        try {
            md = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
        byte[] buf = new byte[1 << 16];
        try (InputStream in = Files.newInputStream(file)) {
            for (int n; (n = in.read(buf)) > 0; ) md.update(buf, 0, n);
        }
        String hex = HexFormat.of().formatHex(md.digest());
        digests.put(key, hex);
        return hex;
    }
}
