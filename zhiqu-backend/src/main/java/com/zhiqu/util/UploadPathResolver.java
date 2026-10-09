package com.zhiqu.util;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

@Component
public class UploadPathResolver {
    @Value("${app.upload-dir:uploads}")
    private String uploadDir;

    public Path primaryPath() {
        Path configured = Paths.get(uploadDir);
        if (configured.isAbsolute()) {
            return configured.normalize();
        }
        return applicationBaseDir().resolve(configured).normalize();
    }

    public String[] resourceLocations() {
        return resourcePaths().stream()
                .map(this::toResourceLocation)
                .toArray(String[]::new);
    }

    public boolean publicUploadExists(String publicUrl) {
        String relative = uploadRelativePath(publicUrl);
        if (relative == null || relative.isBlank()) {
            return false;
        }
        return resourcePaths().stream()
                .map(path -> path.resolve(relative).normalize())
                .anyMatch(Files::isRegularFile);
    }

    private List<Path> resourcePaths() {
        Set<Path> paths = new LinkedHashSet<>();
        paths.add(primaryPath());

        Path configured = Paths.get(uploadDir);
        if (!configured.isAbsolute()) {
            Path userDir = userDir();
            paths.add(userDir.resolve(configured).normalize());
            paths.add(userDir.resolve("target").resolve(configured).normalize());
            if (userDir.getFileName() != null && "target".equalsIgnoreCase(userDir.getFileName().toString()) && userDir.getParent() != null) {
                paths.add(userDir.getParent().resolve(configured).normalize());
            }
        }
        return new ArrayList<>(paths);
    }

    private String uploadRelativePath(String publicUrl) {
        String value = publicUrl == null ? "" : publicUrl.trim();
        int queryIndex = value.indexOf('?');
        if (queryIndex >= 0) {
            value = value.substring(0, queryIndex);
        }
        if (!value.startsWith("/uploads/")) {
            return null;
        }
        String relative = value.substring("/uploads/".length());
        try {
            relative = URLDecoder.decode(relative, StandardCharsets.UTF_8);
        } catch (IllegalArgumentException e) {
            return null;
        }
        if (relative.contains("..") || relative.startsWith("/") || relative.startsWith("\\")) {
            return null;
        }
        return relative.replace('\\', '/');
    }

    private Path applicationBaseDir() {
        Path userDir = userDir();
        if (userDir.getFileName() != null && "target".equalsIgnoreCase(userDir.getFileName().toString()) && userDir.getParent() != null) {
            return userDir.getParent();
        }
        return userDir;
    }

    private Path userDir() {
        return Paths.get(System.getProperty("user.dir")).toAbsolutePath().normalize();
    }

    private String toResourceLocation(Path path) {
        String value = path.toUri().toString();
        if (!value.endsWith("/")) {
            value = value + "/";
        }
        return value;
    }
}
