package com.zhiqu.service.workspace;

import java.net.InetAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/**
 * 工作区能不能开，以及开到哪一档 —— <b>把「配置想要什么」与「实际允许什么」分开</b>。
 *
 * <h2>为什么不能只看配置里的 mode</h2>
 *
 * <p>这个能力让一个监听端口的服务读你硬盘上的文件。它成立需要三个条件同时满足，
 * 而其中两个<b>不在这一段配置里</b>：
 *
 * <ol>
 *   <li>{@code app.workspace.mode} 不是 OFF</li>
 *   <li>{@code app.workspace.root} 指向一个真实存在的目录</li>
 *   <li><b>{@code server.address} 是回环地址</b> —— 这条最容易被忽略。
 *       本仓库的 {@code application.yml} 只有 {@code server.port}，没有 {@code server.address}，
 *       也就是说默认<b>监听所有网卡</b>（实测 {@code TCP *:8080}）。
 *       在那个状态下打开工作区，等于把本机文件读取接口暴露给同一网络里的任何人。</li>
 * </ol>
 *
 * <p>三者缺一，{@link #effectiveMode()} 就是 {@link WorkspaceMode#OFF}，并且
 * {@link #refusalReason()} 说得出是缺哪一条 —— 用户打开开关却没反应时，
 * 必须能知道为什么，而不是以为功能坏了。
 *
 * <h2>为什么是「降级到 OFF」而不是「拒绝启动」</h2>
 *
 * <p>计划里原本写的是启动失败。改成降级，理由是：工作区是<b>附加能力</b>，
 * 而这个系统的主业是学习计划与 AI 助手。因为一条附加能力的配置没配对就让整个系统起不来，
 * 代价与收益不成比例。但降级必须<b>说出来</b>——启动日志里一条 warn，接口里一个明确理由，
 * 而不是静默关掉（静默关掉才是真正糟糕的那种，用户会一直以为它开着）。
 */
public final class WorkspaceAccess {

    private final WorkspaceMode configuredMode;
    private final WorkspaceMode effectiveMode;
    private final Path root;
    private final String refusalReason;

    public WorkspaceAccess(WorkspaceProperties properties, String serverAddress) {
        this.configuredMode = properties.resolvedMode();
        Path resolvedRoot = null;
        String refusal = null;

        if (configuredMode == WorkspaceMode.OFF) {
            refusal = null;   // 本来就没开，不算「被拒绝」
        } else if (properties.getRoot() == null || properties.getRoot().isBlank()) {
            refusal = "app.workspace.mode=" + configuredMode + " 但没有配 app.workspace.root，工作区未启用";
        } else {
            Path candidate = Paths.get(properties.getRoot().trim()).toAbsolutePath().normalize();
            if (!Files.isDirectory(candidate)) {
                refusal = "app.workspace.root 指向的不是一个存在的目录：" + candidate + "，工作区未启用";
            } else if (!isLoopback(serverAddress)) {
                refusal = "app.workspace 需要 server.address 绑定回环地址（当前："
                        + (serverAddress == null || serverAddress.isBlank() ? "未设置，监听所有网卡" : serverAddress)
                        + "）。一个能读本机文件的服务不能暴露在网络上，工作区未启用";
            } else {
                resolvedRoot = candidate;
            }
        }

        this.root = resolvedRoot;
        this.refusalReason = refusal;
        this.effectiveMode = resolvedRoot == null ? WorkspaceMode.OFF : configuredMode;
    }

    /** 配置里写的那一档（可能因为前置不满足而没有生效）。 */
    public WorkspaceMode configuredMode() {
        return configuredMode;
    }

    /** 实际生效的那一档。所有权限判断都该问它，不要问配置。 */
    public WorkspaceMode effectiveMode() {
        return effectiveMode;
    }

    /** 生效时的工作区根目录；未生效时为 {@code null}。 */
    public Path root() {
        return root;
    }

    /** 配了却没生效时的原因；没配或正常生效时为 {@code null}。 */
    public String refusalReason() {
        return refusalReason;
    }

    public boolean enabled() {
        return effectiveMode != WorkspaceMode.OFF;
    }

    /**
     * 未设置视为「监听所有网卡」，不是回环。
     *
     * <p>这里刻意<b>不</b>把空值当成 localhost：Spring 的默认行为就是绑所有网卡，
     * 把它当回环会让这道检查在最常见的那种配置下失效。
     */
    static boolean isLoopback(String address) {
        if (address == null || address.isBlank()) {
            return false;
        }
        try {
            return InetAddress.getByName(address.trim()).isLoopbackAddress();
        } catch (Exception e) {
            return false;
        }
    }
}
