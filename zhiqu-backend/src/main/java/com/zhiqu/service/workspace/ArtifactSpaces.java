package com.zhiqu.service.workspace;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Duration;
import java.util.List;
import java.util.stream.Stream;

/**
 * 生成到产物的临时空间几天没动就清（第一百一十六轮）。文件都在数据库里，接着聊时恢复。
 * 每个后端清自己这台电脑上的；定时任务靠 app.scheduling.enabled 开关。
 */
@Component
public class ArtifactSpaces {
    private static final Logger log = LoggerFactory.getLogger(ArtifactSpaces.class);

    private final WorkspaceProperties properties;

    public ArtifactSpaces(WorkspaceProperties properties) {
        this.properties = properties;
    }

    @Scheduled(fixedDelay = 3_600_000L, initialDelay = 600_000L)
    public void cleanIdle() {
        clean(System.currentTimeMillis());
    }

    /** 判据能给现在几点。删了几段返回几 */
    int clean(long nowMillis) {
        long cutoff = nowMillis - Duration.ofDays(Math.max(1, properties.getArtifactRetentionDays())).toMillis();
        Path base = Paths.get(properties.getArtifactDir());
        int removed = 0;
        for (Path account : children(base)) {
            for (Path space : children(account)) {
                if (newest(space) < cutoff) {
                    deleteTree(space);
                    removed++;
                }
            }
        }
        return removed;
    }

    private static List<Path> children(Path dir) {
        if (!Files.isDirectory(dir, LinkOption.NOFOLLOW_LINKS)) {
            return List.of();
        }
        try (Stream<Path> s = Files.list(dir)) {
            return s.filter(p -> Files.isDirectory(p, LinkOption.NOFOLLOW_LINKS)).toList();
        } catch (IOException e) {
            return List.of();
        }
    }

    /** 这段空间里最新的修改时间：目录自己的时间不够（改里面的文件不算） */
    private static long newest(Path space) {
        long[] latest = {0};
        try {
            Files.walkFileTree(space, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                    latest[0] = Math.max(latest[0], attrs.lastModifiedTime().toMillis());
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                    latest[0] = Math.max(latest[0], attrs.lastModifiedTime().toMillis());
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFileFailed(Path file, IOException e) {
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException e) {
            return Long.MAX_VALUE;   // 看不清就不删
        }
        return latest[0];
    }

    /** 不跟软链：walkFileTree 默认就不跟，软链只删它自己 */
    public static void deleteTree(Path dir) {
        if (!Files.exists(dir, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }
        try {
            Files.walkFileTree(dir, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                    Files.deleteIfExists(file);
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult postVisitDirectory(Path d, IOException e) throws IOException {
                    Files.deleteIfExists(d);
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException e) {
            log.warn("删临时空间失败 {}：{}", dir, e.toString());
        }
    }
}
