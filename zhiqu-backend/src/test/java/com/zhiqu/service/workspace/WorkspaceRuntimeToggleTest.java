package com.zhiqu.service.workspace;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 运行时切换档位 / 根目录。
 *
 * <p>最要紧的一条：<b>界面上的切换按钮绕不过三条前提</b>。尤其是回环 —— 在公网实例上
 * 无论把档位点到 EXEC 还是 READ，实际生效的都必须是 OFF。切换只改「想要什么」，
 * 「实际允许什么」永远由 {@link WorkspaceAccess} 那三条前提裁决。
 */
class WorkspaceRuntimeToggleTest {

    private WorkspaceSettingsStore store(Path dir) {
        return new WorkspaceSettingsStore(dir.resolve("state.json").toString(), new ObjectMapper());
    }

    private WorkspaceService service(Path dir, String serverAddress) {
        WorkspaceProperties props = new WorkspaceProperties();   // 默认 OFF、root 空
        return new WorkspaceService(props, store(dir), serverAddress);
    }

    @Test
    @DisplayName("回环本机：切到 EXEC + 指向存在的目录 → 实际就是 EXEC")
    void 回环上切EXEC生效(@TempDir Path dir) throws IOException {
        Path root = Files.createDirectory(dir.resolve("proj"));
        WorkspaceService svc = service(dir, "127.0.0.1");
        assertEquals(WorkspaceMode.OFF, svc.access().effectiveMode(), "初始应为 OFF");

        svc.applySettings("EXEC", root.toString());
        assertEquals(WorkspaceMode.EXEC, svc.access().effectiveMode());
        assertTrue(svc.access().enabled());
        assertEquals(root, svc.access().root());
    }

    @Test
    @DisplayName("公网实例（非回环）：切到 EXEC 也只能是 OFF —— 按钮绕不过回环这条")
    void 非回环上切EXEC仍是OFF(@TempDir Path dir) throws IOException {
        Path root = Files.createDirectory(dir.resolve("proj"));
        // server.address 未绑回环（空 = 监听所有网卡）
        WorkspaceService svc = service(dir, "");

        svc.applySettings("EXEC", root.toString());
        assertEquals(WorkspaceMode.OFF, svc.access().effectiveMode(),
                "非回环上切换按钮不能把工作区打开 —— 这条是这个功能的安全底线");
        assertFalse(svc.access().enabled());
        assertTrue(svc.access().refusalReason() != null && svc.access().refusalReason().contains("回环"),
                "要说清是回环这条没满足：" + svc.access().refusalReason());
    }

    @Test
    @DisplayName("根目录不存在 → 降级 OFF，且理由点名那个目录")
    void 根目录不存在则降级(@TempDir Path dir) throws IOException {
        WorkspaceService svc = service(dir, "127.0.0.1");
        svc.applySettings("EXEC", dir.resolve("does-not-exist").toString());
        assertEquals(WorkspaceMode.OFF, svc.access().effectiveMode());
        assertTrue(svc.access().refusalReason().contains("does-not-exist"), svc.access().refusalReason());
    }

    @Test
    @DisplayName("认不出的档位一律回落 OFF —— 配错一个字母不该把能力打开")
    void 乱档位回落OFF(@TempDir Path dir) throws IOException {
        Path root = Files.createDirectory(dir.resolve("proj"));
        WorkspaceService svc = service(dir, "127.0.0.1");
        svc.applySettings("SUPER", root.toString());
        assertEquals(WorkspaceMode.OFF, svc.access().effectiveMode());
    }

    @Test
    @DisplayName("切换持久化：换一个进程（同一个 store）重启后仍在")
    void 切换持久化(@TempDir Path dir) throws IOException {
        Path root = Files.createDirectory(dir.resolve("proj"));
        WorkspaceService first = service(dir, "127.0.0.1");
        first.applySettings("WRITE", root.toString());

        // 同一个 store 文件，新起一个 service —— 模拟应用重启
        WorkspaceService restarted = new WorkspaceService(new WorkspaceProperties(), store(dir), "127.0.0.1");
        assertEquals(WorkspaceMode.WRITE, restarted.access().effectiveMode(),
                "重启后应当恢复到用户上次选的档位，而不是回到配置默认的 OFF");
        assertEquals(root, restarted.access().root());
    }

    @Test
    @DisplayName("存的是「选的档位」而非「降级结果」：非回环上选 EXEC，换到回环机器后自动是 EXEC")
    void 存选择而非降级结果(@TempDir Path dir) throws IOException {
        Path root = Files.createDirectory(dir.resolve("proj"));
        // 在非回环实例上选 EXEC —— 实际降级为 OFF
        WorkspaceService onServer = service(dir, "");
        onServer.applySettings("EXEC", root.toString());
        assertEquals(WorkspaceMode.OFF, onServer.access().effectiveMode());
        assertEquals("EXEC", onServer.currentSelection().mode(),
                "持久化的应当是用户选的 EXEC，不是降级后的 OFF —— 否则换到能开的机器上也永远打不开了");

        // 同一份 store 拿到回环机器上：应当自动变成 EXEC
        WorkspaceService onLaptop = new WorkspaceService(new WorkspaceProperties(), store(dir), "127.0.0.1");
        assertEquals(WorkspaceMode.EXEC, onLaptop.access().effectiveMode(),
                "选择跟着走：回环机器上同一份选择应当生效为 EXEC");
    }

    @Test
    @DisplayName("切回 OFF 就关掉")
    void 切回OFF关掉(@TempDir Path dir) throws IOException {
        Path root = Files.createDirectory(dir.resolve("proj"));
        WorkspaceService svc = service(dir, "127.0.0.1");
        svc.applySettings("EXEC", root.toString());
        assertTrue(svc.access().enabled());
        svc.applySettings("OFF", root.toString());
        assertFalse(svc.access().enabled());
    }

    // ── 文件夹浏览器 ──────────────────────────────────────────────────

    @Test
    @DisplayName("浏览器只列子目录，不列文件；给出上一级")
    void 浏览器只列目录(@TempDir Path dir) throws IOException {
        Files.createDirectory(dir.resolve("sub1"));
        Files.createDirectory(dir.resolve("sub2"));
        Files.writeString(dir.resolve("a-file.txt"), "x");
        WorkspaceService svc = service(dir, "127.0.0.1");

        WorkspaceService.Browse browse = svc.browseDirectories(dir.toString());
        assertEquals(2, browse.dirs().size(), "只应列出两个子目录，不含那个文件");
        assertTrue(browse.dirs().stream().allMatch(d -> Files.isDirectory(Path.of(d.path()))));
        assertEquals(dir.getParent().toString(), browse.parent(), "要能回上一级");
    }

    @Test
    @DisplayName("浏览不存在 / 无权限的目录返回空，不抛异常")
    void 浏览坏目录不抛(@TempDir Path dir) {
        WorkspaceService svc = service(dir, "127.0.0.1");
        WorkspaceService.Browse browse = svc.browseDirectories(dir.resolve("nope").resolve("deep").toString());
        assertTrue(browse.dirs().isEmpty(), "点进不存在的目录应当是空列表");
    }
}
