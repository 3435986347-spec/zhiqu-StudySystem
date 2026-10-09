package com.zhiqu.service.workspace;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.Optional;

/**
 * 用户在界面上选的「档位 + 根目录」<b>持久化到磁盘</b>，重启后还在。
 *
 * <h2>为什么必须持久化</h2>
 *
 * <p>桌面应用每次启动都是一个新 JVM。档位只放在内存里的话，用户选了工作文件夹、开了 EXEC，
 * 关掉应用再打开就全没了、回到 OFF —— 那不是「安全默认」，是「记不住设置」。
 * 所以存成一个小 JSON，放在 {@code ~/.zhiqu/}（和可选的 application.yml 同一个目录）。
 *
 * <h2>这里存的是「想要什么」，不是「允许什么」</h2>
 *
 * <p>这个文件只记录用户的选择。它<b>不</b>决定工作区是否真的开启 —— 那由
 * {@link WorkspaceAccess} 的三条前提（回环 / 目录存在 / 档位≠OFF）在每次读取时重新裁决。
 * 所以把这个文件从服务器 A 拷到公网服务器 B 上，B 因为不绑回环，读出来仍然是 OFF。
 *
 * <p>读文件坏了（手改乱了 / 截断）一律当成「没设过」，回落到配置默认值，<b>绝不让启动崩</b>：
 * 一个记设置的附属文件，不该有能力阻止整个应用起来。
 */
@Component
public class WorkspaceSettingsStore {

    private static final Logger log = LoggerFactory.getLogger(WorkspaceSettingsStore.class);

    /** 用户选的档位与根目录。二者都可能为空（还没选过）。 */
    public record Settings(String mode, String root) {
    }

    private final Path file;
    private final ObjectMapper objectMapper;

    public WorkspaceSettingsStore(
            @Value("${app.workspace.state-file:${user.home}/.zhiqu/workspace-state.json}") String statePath,
            ObjectMapper objectMapper) {
        this.file = Paths.get(statePath);
        this.objectMapper = objectMapper;
    }

    /** 读出用户上次的选择；文件不存在或读坏了返回空。 */
    public synchronized Optional<Settings> load() {
        if (!Files.isRegularFile(file)) {
            return Optional.empty();
        }
        try {
            String json = Files.readString(file, StandardCharsets.UTF_8);
            Settings s = objectMapper.readValue(json, Settings.class);
            if (s == null) {
                return Optional.empty();
            }
            return Optional.of(s);
        } catch (Exception e) {
            // 坏了就当没设过 —— 不让一个附属文件阻止启动，也不覆盖用户的坏文件（留着让他自己看）。
            log.warn("读取工作区设置失败，按未设置处理：{}", e.toString());
            return Optional.empty();
        }
    }

    /** 保存用户的选择。写临时文件再原子改名 —— 中途崩了不会留下半个 JSON。 */
    public synchronized void save(Settings settings) throws IOException {
        Path parent = file.toAbsolutePath().getParent();
        if (parent != null) {
            Files.createDirectories(parent);
        }
        Path tmp = Files.createTempFile(parent, "workspace-state", ".tmp");
        Files.writeString(tmp, objectMapper.writeValueAsString(settings), StandardCharsets.UTF_8);
        try {
            Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (java.nio.file.AtomicMoveNotSupportedException e) {
            Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING);
        }
    }
}
