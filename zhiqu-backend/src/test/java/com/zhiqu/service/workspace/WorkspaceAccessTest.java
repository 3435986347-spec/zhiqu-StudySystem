package com.zhiqu.service.workspace;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 工作区的三个前置条件 —— 其中一条不在这段配置里，而它最容易被忽略。
 *
 * <h2>绑回环这条为什么必须由代码检查</h2>
 *
 * <p>本仓库的 {@code application.yml} 只有 {@code server.port}，<b>没有 {@code server.address}</b>，
 * 也就是说默认监听所有网卡（实测 {@code TCP *:8080}）。在那个状态下打开工作区，
 * 等于把「读本机任意源码文件」的接口开给同一网络里的所有人。
 *
 * <p>这条约束没法写进配置校验注解，也不该只写进文档里的一句提醒 ——
 * 文档不会在有人配错时拦住他。
 */
class WorkspaceAccessTest {

    private static WorkspaceProperties props(String mode, String root) {
        WorkspaceProperties p = new WorkspaceProperties();
        p.setMode(mode);
        p.setRoot(root);
        return p;
    }

    @Test
    void 三条都满足时按配置的档位生效(@TempDir Path root) {
        WorkspaceAccess access = new WorkspaceAccess(props("READ", root.toString()), "127.0.0.1");
        assertEquals(WorkspaceMode.READ, access.effectiveMode());
        assertTrue(access.enabled());
        assertNotNull(access.root(), "生效时必须给出根目录");
        assertNull(access.refusalReason(), "正常生效时不该有拒绝理由");
    }

    /**
     * 没绑回环 → 降级到 OFF。
     *
     * <p>扰动：去掉 isLoopback 检查 → 本条红。
     */
    @Test
    void 没绑回环时必须降级到关闭(@TempDir Path root) {
        for (String addr : new String[]{null, "", "0.0.0.0", "192.168.1.10", "10.0.0.5", "::"}) {
            WorkspaceAccess access = new WorkspaceAccess(props("READ", root.toString()), addr);
            assertEquals(WorkspaceMode.OFF, access.effectiveMode(),
                    "server.address=「" + addr + "」不是回环，工作区必须不生效");
            assertFalse(access.enabled());
            assertNotNull(access.refusalReason(), "必须说得出为什么没生效，否则用户以为功能坏了");
            assertTrue(access.refusalReason().contains("server.address"),
                    "理由要点名是哪一条不满足，实际：" + access.refusalReason());
        }
    }

    /**
     * 未设置 {@code server.address} 必须<b>不</b>算回环。
     *
     * <p>这是上一条里最要紧的那个用例，单独说明：Spring 不设这一项就是绑所有网卡。
     * 把空值当成 localhost，会让这道检查恰好在最常见的那种配置下失效 ——
     * 也就是「什么都没配」的那种。
     */
    @Test
    void 未设置地址不得被当成回环() {
        assertFalse(WorkspaceAccess.isLoopback(null));
        assertFalse(WorkspaceAccess.isLoopback("   "));
        assertTrue(WorkspaceAccess.isLoopback("127.0.0.1"));
        assertTrue(WorkspaceAccess.isLoopback("localhost"));
        assertTrue(WorkspaceAccess.isLoopback("::1"));
    }

    @Test
    void 没配根目录时必须降级到关闭() {
        WorkspaceAccess access = new WorkspaceAccess(props("EXEC", ""), "127.0.0.1");
        assertEquals(WorkspaceMode.OFF, access.effectiveMode());
        assertTrue(access.refusalReason().contains("app.workspace.root"),
                "理由要点名缺的是根目录，实际：" + access.refusalReason());
    }

    @Test
    void 根目录不存在时必须降级到关闭(@TempDir Path root) {
        WorkspaceAccess access = new WorkspaceAccess(
                props("WRITE", root.resolve("没有这个目录").toString()), "127.0.0.1");
        assertEquals(WorkspaceMode.OFF, access.effectiveMode());
        assertNotNull(access.refusalReason());
    }

    /**
     * 没开就不该有「拒绝理由」—— 那会让启动日志里凭空多出一条看着像故障的告警。
     */
    @Test
    void 本来就没开时不算被拒绝() {
        WorkspaceAccess access = new WorkspaceAccess(props("OFF", ""), "127.0.0.1");
        assertEquals(WorkspaceMode.OFF, access.effectiveMode());
        assertNull(access.refusalReason(), "没配过工作区的部署不该看到任何告警");
    }

    /** 配置里写的档位要如实保留，好让日志说清「你想开 EXEC，但没生效」。 */
    @Test
    void 配置档位与生效档位要分开报告(@TempDir Path root) {
        WorkspaceAccess access = new WorkspaceAccess(props("EXEC", root.toString()), "0.0.0.0");
        assertEquals(WorkspaceMode.EXEC, access.configuredMode(), "配置里写的那一档要留着");
        assertEquals(WorkspaceMode.OFF, access.effectiveMode(), "而实际生效的是 OFF");
    }
}
