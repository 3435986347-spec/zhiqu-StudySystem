package com.zhiqu.service.workspace;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 档位和文件夹分账号（第一百一十五轮，用户要的）。真的 WorkspaceRegistry + 真的文件。 */
class WorkspaceAccountsTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @TempDir
    Path dir;

    private WorkspaceRegistry registry(WorkspaceProperties props, String address, String profiles) {
        return new WorkspaceRegistry(props, JSON, dir.resolve("workspace-state.json").toString(), address, profiles);
    }

    private WorkspaceRegistry registry() {
        return registry(new WorkspaceProperties(), "127.0.0.1", "");
    }

    private Path folder(String name) throws Exception {
        return Files.createDirectories(dir.resolve(name)).toRealPath();
    }

    @Test
    @DisplayName("两个账号各选各的：文件夹和档位互不影响，读写的是自己那一份；同一个账号拿到的是同一份")
    void 两个账号互不影响() throws Exception {
        WorkspaceRegistry r = registry();
        Path a = folder("a");
        Path b = folder("b");
        Files.writeString(a.resolve("only-a.txt"), "这是 A 的");
        Files.writeString(b.resolve("only-b.txt"), "这是 B 的");
        r.service(1L).applySettings("EXEC", a.toString());
        r.service(2L).applySettings("READ", b.toString());

        assertEquals(a, r.service(1L).access().root());
        assertEquals(b, r.service(2L).access().root());
        assertEquals(WorkspaceMode.EXEC, r.service(1L).access().effectiveMode());
        assertEquals(WorkspaceMode.READ, r.service(2L).access().effectiveMode());
        assertEquals("这是 A 的", r.service(1L).read("only-a.txt"));
        assertEquals("这是 B 的", r.service(2L).read("only-b.txt"));
        assertThrows(RuntimeException.class, () -> r.service(2L).read("only-a.txt"), "B 读不到 A 文件夹里的文件");
        assertEquals("EXEC", r.service(1L).currentSelection().mode());
        assertEquals(b.toString(), r.service(2L).currentSelection().root());
        // 执行器跟着账号走：A 的 EXEC 不给 B
        assertTrue(r.executor(1L).enabled());
        assertFalse(r.executor(2L).enabled(), "B 是只读");

        // 切一个不影响另一个
        r.service(1L).applySettings("OFF", "");
        assertFalse(r.service(1L).access().enabled());
        assertTrue(r.service(2L).access().enabled());
        assertFalse(r.executor(1L).enabled(), "执行器跟着档位走，不存死");
    }

    @Test
    @DisplayName("没开过的账号是关的；重启后各自的选择还在（一个账号一个文件）")
    void 默认关_重启还在() throws Exception {
        WorkspaceRegistry r = registry();
        assertFalse(r.service(3L).access().enabled());
        assertEquals("OFF", r.service(3L).currentSelection().mode());
        Path a = folder("a");
        r.service(1L).applySettings("WRITE", a.toString());

        WorkspaceRegistry restarted = registry();
        assertEquals(a, restarted.service(1L).access().root());
        assertEquals(WorkspaceMode.WRITE, restarted.service(1L).access().effectiveMode());
        assertFalse(restarted.service(3L).access().enabled());
        assertTrue(Files.isRegularFile(dir.resolve("workspace-state").resolve("1.json")));
    }

    @Test
    @DisplayName("原来那份不分账号的状态文件谁也不继承，也不被动它")
    void 老文件谁也不继承() throws Exception {
        Path a = folder("a");
        Path old = dir.resolve("workspace-state.json");
        String oldText = JSON.writeValueAsString(new WorkspaceSettingsStore.Settings("EXEC", a.toString()));
        Files.writeString(old, oldText);
        WorkspaceRegistry r = registry();
        assertFalse(r.service(1L).access().enabled(), "原来开着 EXEC 的那份不能变成每个账号都开着");
        r.service(1L).applySettings("READ", a.toString());
        assertEquals(oldText, Files.readString(old));
    }

    @Test
    @DisplayName("生产环境：选了什么都是关的，说得出为什么；不能再有文件夹的入口")
    void 生产环境一律关() throws Exception {
        Path a = folder("a");
        WorkspaceProperties props = new WorkspaceProperties();
        props.setMode("EXEC");
        props.setRoot(a.toString());
        WorkspaceRegistry prod = registry(props, "127.0.0.1", "prod");   // 服务器上就是绑回环 + Caddy 转发
        assertFalse(prod.service(1L).access().enabled(), "配置给了也不行");
        assertNull(prod.service(1L).access().root());
        assertNotNull(prod.service(1L).access().refusalReason());
        prod.service(1L).applySettings("EXEC", a.toString());
        assertFalse(prod.service(1L).access().enabled(), "在界面上选了也不行");
        assertFalse(prod.executor(1L).enabled());
        assertFalse(prod.localDiskAllowed());
        assertFalse(prod.openByDefault());
        assertTrue(registry().localDiskAllowed());
    }

    @Test
    @DisplayName("配置给了默认档位才算默认开着：没配、不是回环、生产都不算")
    void 默认开着的判定() throws Exception {
        assertFalse(registry().openByDefault());
        WorkspaceProperties props = new WorkspaceProperties();
        props.setMode("READ");
        props.setRoot(folder("a").toString());
        assertTrue(registry(props, "127.0.0.1", "").openByDefault());
        assertFalse(registry(props, "", "").openByDefault(), "没绑回环：档位不生效");
        assertFalse(registry(props, "0.0.0.0", "").openByDefault());
        // 配置给的默认对每个没选过的账号都生效（本机开发用），选过的以自己的为准
        WorkspaceRegistry r = registry(props, "127.0.0.1", "");
        assertTrue(r.service(1L).access().enabled());
        r.service(1L).applySettings("OFF", "");
        assertFalse(r.service(1L).access().enabled());
        assertTrue(r.service(2L).access().enabled());
    }

    @Test
    @DisplayName("不知道是哪个账号就不给")
    void 没有账号不给() {
        assertThrows(NullPointerException.class, () -> registry().service(null));
    }
}
