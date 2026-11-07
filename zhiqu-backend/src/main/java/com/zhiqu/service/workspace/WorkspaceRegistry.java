package com.zhiqu.service.workspace;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.DeploymentProfiles;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

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
            WorkspaceService service = new WorkspaceService(properties, store, serverAddress, production);
            return new Account(service, new WorkspaceExecutor(properties, service, activeProfiles));
        });
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
