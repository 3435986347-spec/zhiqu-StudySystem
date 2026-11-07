package com.zhiqu.service.workspace;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.DeploymentProfiles;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 档位和文件夹分账号（第一百一十五轮，用户要的）：每个账号一份 {@link WorkspaceService} + {@link WorkspaceExecutor}。
 *
 * <p>选择存在这台电脑上（{@code ~/.zhiqu/workspace-state/<账号>.json}），不进数据库：路径只在这台电脑上有意义，
 * 而几个后端连同一个库。原来那份不分账号的 {@code workspace-state.json} 谁也不继承，新账号默认是关的。
 *
 * <p>只取用得到的账号才建，建一份不碰磁盘以外的东西，也不占什么内存：服务器上档位都是关的，不建 guard。
 */
@Service
public class WorkspaceRegistry {

    private record Account(WorkspaceService service, WorkspaceExecutor executor) {
    }

    /** 这一轮代码模式实际用哪一份：这个账号选的文件夹，或者这段对话的临时空间（artifact = true） */
    public record CodeTarget(WorkspaceService service, WorkspaceExecutor executor, boolean artifact) {
    }

    private static final Logger log = LoggerFactory.getLogger(WorkspaceRegistry.class);

    private final WorkspaceProperties properties;
    private final ObjectMapper objectMapper;
    private final Path stateDir;
    private final String serverAddress;
    private final String activeProfiles;
    private final boolean production;
    private final ConcurrentHashMap<Long, Account> accounts = new ConcurrentHashMap<>();

    public WorkspaceRegistry(WorkspaceProperties properties, ObjectMapper objectMapper,
                             @Value("${app.workspace.state-file:${user.home}/.zhiqu/workspace-state.json}") String stateFile,
                             @Value("${server.address:}") String serverAddress,
                             @Value("${spring.profiles.active:}") String activeProfiles) {
        this.properties = properties;
        this.objectMapper = objectMapper;
        this.stateDir = Paths.get(stateFile.replaceFirst("\\.json$", ""));
        this.serverAddress = serverAddress;
        this.activeProfiles = activeProfiles;
        this.production = DeploymentProfiles.isProduction(activeProfiles);
    }

    public WorkspaceService service(Long userId) {
        return account(userId).service();
    }

    public WorkspaceExecutor executor(Long userId) {
        return account(userId).executor();
    }

    private Account account(Long userId) {
        Objects.requireNonNull(userId, "工作区分账号：要知道是哪个账号");
        return accounts.computeIfAbsent(userId, id -> {
            WorkspaceSettingsStore store = new WorkspaceSettingsStore(stateDir.resolve(id + ".json").toString(), objectMapper);
            WorkspaceService service = new WorkspaceService(properties, store, serverAddress, production, artifactAllowed());
            return new Account(service, new WorkspaceExecutor(properties, service, activeProfiles));
        });
    }

    /**
     * 这一轮用哪一份。conversationId 为空（调用方不知道是哪段对话）时临时空间按账号放一个。
     * 建不了目录：临时空间那一份的 root 是空的，循环起不来，主回答照常。
     */
    public CodeTarget target(Long userId, Long conversationId) {
        WorkspaceService mine = service(userId);
        WorkspaceAccess access = mine.access();
        if (!access.artifactMode()) {
            return new CodeTarget(mine, executor(userId), false);
        }
        Path root = space(userId, conversationId);
        try {
            Files.createDirectories(root);
            restrictToOwner(Paths.get(properties.getArtifactDir()));
        } catch (java.io.IOException e) {
            log.warn("临时空间建不了 {}：{}", root, e.toString());
            return new CodeTarget(mine, executor(userId), true);
        }
        WorkspaceService scratch = WorkspaceService.scratch(properties, access.effectiveMode(), real(root));
        // 本机的后端走普通的沙箱；服务器上打开了才有那份最小环境。userId 用来限一个账号一次一条
        return new CodeTarget(scratch, new WorkspaceExecutor(properties, scratch, activeProfiles, hostedShellOn() ? hostedGate() : null, userId), true);
    }

    private boolean hostedShellOn() {
        return artifactOnly() && properties.isHostedShellEnabled();
    }

    private volatile HostedShellGate gate;

    /** 全站一个：一段对话一个执行器，但同时跑几条是全站的事 */
    private synchronized HostedShellGate hostedGate() {
        if (gate == null) {
            gate = new HostedShellGate(properties.getHostedShellSlots(), properties.getHostedShellWaitMs());
        }
        return gate;
    }

    public Path space(Long userId, Long conversationId) {
        Objects.requireNonNull(userId, "工作区分账号：要知道是哪个账号");
        return Paths.get(properties.getArtifactDir(), String.valueOf(userId), conversationId == null ? "default" : String.valueOf(conversationId));
    }

    /** 对话删了：临时空间一起删。删不掉不影响别的，几天后清理任务还会来 */
    public void deleteSpace(Long userId, Long conversationId) {
        ArtifactSpaces.deleteTree(space(userId, conversationId));
    }

    private static Path real(Path p) {
        try {
            return p.toRealPath();
        } catch (java.io.IOException e) {
            return p.toAbsolutePath().normalize();
        }
    }

    private static void restrictToOwner(Path dir) {
        try {
            Files.setPosixFilePermissions(dir, java.nio.file.attribute.PosixFilePermissions.fromString("rwx------"));
        } catch (UnsupportedOperationException | java.io.IOException ignored) {
            // Windows：没有 POSIX 权限，放在用户自己的目录下
        }
    }

    /** 没选文件夹时能不能生成到产物：本机绑回环的后端可以；服务器上要明说打开 */
    public boolean artifactAllowed() {
        return production ? properties.isHostedEnabled() : loopbackBound();
    }

    /** 服务器上：只有产物这一种，没有选文件夹。切档位的接口据此放开（Host 是公开的域名） */
    public boolean artifactOnly() {
        return production && properties.isHostedEnabled();
    }

    /** 文件夹、系统的选择框这些入口能不能用：服务器上不能（读的是服务器的磁盘）。 */
    public boolean localDiskAllowed() {
        return !production;
    }

    public boolean loopbackBound() {
        return WorkspaceAccess.isLoopback(serverAddress);
    }

    /** 配置给了默认档位、而且真的会生效：新账号一注册就有档位。见 WorkspaceDefaultLocalFilter */
    public boolean openByDefault() {
        return properties.resolvedMode() != WorkspaceMode.OFF && !production && loopbackBound();
    }
}
