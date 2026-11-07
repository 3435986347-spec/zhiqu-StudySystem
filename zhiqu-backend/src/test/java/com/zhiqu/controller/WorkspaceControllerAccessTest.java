package com.zhiqu.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.zhiqu.common.BusinessException;
import com.zhiqu.common.Result;
import com.zhiqu.service.workspace.WorkspaceFolderDialog;
import com.zhiqu.service.workspace.WorkspaceProperties;
import com.zhiqu.service.workspace.WorkspaceRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.function.Executable;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** 工作区接口：普通账号能用、分账号、只认本机（第一百一十五轮）。真的控制器 + 真的 WorkspaceRegistry。 */
class WorkspaceControllerAccessTest {

    @TempDir
    Path dir;

    private final MockHttpServletRequest request = new MockHttpServletRequest();
    private final WorkspaceFolderDialog dialog = mock(WorkspaceFolderDialog.class);

    private WorkspaceController controller(String profiles) {
        request.setRemoteAddr("127.0.0.1");
        request.addHeader("Host", "localhost:8080");
        return new WorkspaceController(
                new WorkspaceRegistry(new WorkspaceProperties(), new ObjectMapper(), dir.resolve("state.json").toString(), "127.0.0.1", profiles),
                dialog, request);
    }

    private static void as(long userId) {
        SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(userId, null, List.of()));
    }

    @AfterEach
    void clear() {
        SecurityContextHolder.clearContext();
    }

    private static Map<String, Object> data(Result<Map<String, Object>> r) {
        return r.getData();
    }

    @Test
    @DisplayName("普通账号（没有任何角色）：选文件夹、开档位、读文件都能用，走的是自己的那一份")
    void 普通账号能用而且分账号() throws Exception {
        WorkspaceController c = controller("");
        Path a = Files.createDirectories(dir.resolve("a")).toRealPath();
        Files.writeString(a.resolve("x.txt"), "A 的文件");
        as(11);
        assertEquals("OFF", data(c.settings()).get("selectedMode"), "新账号默认关");
        assertEquals("EXEC", data(c.updateSettings(Map.of("mode", "EXEC", "root", a.toString()))).get("effectiveMode"));
        assertEquals("A 的文件", data(c.file("x.txt")).get("content"));
        assertEquals(a.toString(), data(c.status()).get("root"));

        as(22);
        Map<String, Object> other = data(c.settings());
        assertEquals("OFF", other.get("selectedMode"), "另一个账号看不到、也用不上");
        assertEquals("", other.get("root"));
        assertThrows(BusinessException.class, () -> c.file("x.txt"), "另一个账号读不到");
        assertThrows(BusinessException.class, () -> c.files(null));
        assertThrows(BusinessException.class, () -> c.search("A", null));

        as(11);
        assertEquals("EXEC", data(c.settings()).get("selectedMode"), "A 的还在");
    }

    private List<Executable> everyEndpoint(WorkspaceController c) {
        return List.of(c::status, c::settings, () -> c.updateSettings(Map.of("mode", "EXEC", "root", dir.toString())),
                () -> c.pickFolder(null), () -> c.browse(null), () -> c.files(null), () -> c.file("x.txt"), () -> c.search("x", null));
    }

    @Test
    @DisplayName("Host 是陌生域名（DNS 重绑定）、带转发头：每个接口都拒绝，选择没有被改，框也没有弹")
    void 陌生请求每个接口都拒绝() throws Exception {
        for (String[] bad : new String[][] {{"Host", "evil.example:8080"}, {"X-Forwarded-For", "203.0.113.9"}}) {
            MockHttpServletRequest fresh = new MockHttpServletRequest();
            fresh.setRemoteAddr("127.0.0.1");
            fresh.addHeader("Host", bad[0].equals("Host") ? bad[1] : "localhost:8080");
            if (!bad[0].equals("Host")) {
                fresh.addHeader(bad[0], bad[1]);
            }
            WorkspaceRegistry registry = new WorkspaceRegistry(new WorkspaceProperties(), new ObjectMapper(), dir.resolve("state.json").toString(), "127.0.0.1", "");
            WorkspaceController c = new WorkspaceController(registry, dialog, fresh);
            as(33);
            for (Executable call : everyEndpoint(c)) {
                BusinessException e = assertThrows(BusinessException.class, call);
                assertTrue(e.getMessage().contains("本机"), e.getMessage());
            }
            assertEquals("OFF", registry.service(33L).currentSelection().mode(), "档位没有被陌生请求改掉");
            assertFalse(Files.exists(dir.resolve("state").resolve("33.json")));
            verify(dialog, never()).pick(org.mockito.ArgumentMatchers.any());
        }
    }

    @Test
    @DisplayName("生产环境：连本机的请求也不给（服务器上有人登录到桌面，这些入口还是服务器的磁盘）")
    void 生产环境每个接口都拒绝() {
        WorkspaceController c = controller("prod");
        as(44);
        for (Executable call : everyEndpoint(c)) {
            assertThrows(BusinessException.class, call);
        }
    }

    @Test
    @DisplayName("系统的选文件夹框：本机的普通账号能弹")
    void 普通账号能弹框() {
        WorkspaceController c = controller("");
        when(dialog.pick(org.mockito.ArgumentMatchers.any())).thenReturn(new WorkspaceFolderDialog.Pick("/x", false, null));
        as(55);
        assertEquals("/x", data(c.pickFolder(null)).get("path"));
    }

    // ── 服务器上（第一百一十六轮）────────────────────────────

    private WorkspaceController hosted(MockHttpServletRequest req, boolean enabled) {
        WorkspaceProperties props = new WorkspaceProperties();
        props.setArtifactDir(dir.resolve("spaces").toString());
        props.setHostedEnabled(enabled);
        return new WorkspaceController(new WorkspaceRegistry(props, new ObjectMapper(), dir.resolve("state.json").toString(), "127.0.0.1", "prod"), dialog, req);
    }

    private static MockHttpServletRequest viaCaddy() {
        MockHttpServletRequest r = new MockHttpServletRequest();
        r.setRemoteAddr("127.0.0.1");
        r.addHeader("Host", "zhiqustudy.com");
        r.addHeader("X-Forwarded-For", "203.0.113.9");
        return r;
    }

    @Test
    @DisplayName("服务器打开之后：经过 Caddy 的账号能切自己的档位，只生成到产物；写了目录也不存；碰磁盘的接口一律拒绝")
    void 服务器上能切档位不能碰磁盘() throws Exception {
        WorkspaceController c = hosted(viaCaddy(), true);
        as(66);
        Map<String, Object> first = data(c.settings());
        assertEquals("OFF", first.get("selectedMode"));
        assertEquals(true, first.get("artifactOnly"));
        Map<String, Object> on = data(c.updateSettings(Map.of("mode", "EXEC", "root", "/etc")));
        assertEquals("EXEC", on.get("effectiveMode"));
        assertEquals(true, on.get("artifactMode"));
        assertEquals("", on.get("selectedRoot"), "写的目录不存");
        assertEquals(true, data(c.status()).get("enabled"));
        for (Executable disk : List.<Executable>of(() -> c.pickFolder(null), () -> c.browse("/etc"), () -> c.files(null), () -> c.file("passwd"), () -> c.search("x", null))) {
            BusinessException e = assertThrows(BusinessException.class, disk);
            assertTrue(e.getMessage().contains("本机"), "拦它的要是本机这道门，不是碰巧没有文件夹：" + e.getMessage());
        }
        verify(dialog, never()).pick(org.mockito.ArgumentMatchers.any());
        as(77);
        assertEquals("OFF", data(c.settings()).get("selectedMode"), "另一个账号不受影响");
    }

    @Test
    @DisplayName("服务器上后端没绑回环（server.address 没配）：一样能切档位，那道回环的门只管本机的后端")
    void 服务器没绑回环也能切档位() throws Exception {
        WorkspaceProperties props = new WorkspaceProperties();
        props.setArtifactDir(dir.resolve("spaces").toString());
        props.setHostedEnabled(true);
        WorkspaceController c = new WorkspaceController(new WorkspaceRegistry(props, new ObjectMapper(), dir.resolve("state.json").toString(), "", "prod"), dialog, viaCaddy());
        as(66);
        assertEquals("READ", data(c.updateSettings(Map.of("mode", "READ"))).get("effectiveMode"));
    }

    @Test
    @DisplayName("服务器没打开：和原来一样，每个接口都拒绝")
    void 服务器没打开都拒绝() {
        WorkspaceController c = hosted(viaCaddy(), false);
        as(66);
        for (Executable call : everyEndpoint(c)) {
            assertThrows(BusinessException.class, call);
        }
    }

    @Test
    @DisplayName("本机的后端（不是生产）：陌生网页还是开不了档位，生成到产物也不行：不然它就能在用户电脑上跑命令")
    void 本机后端陌生网页开不了产物() {
        MockHttpServletRequest evil = new MockHttpServletRequest();
        evil.setRemoteAddr("127.0.0.1");
        evil.addHeader("Host", "evil.example:8080");
        WorkspaceProperties props = new WorkspaceProperties();
        props.setArtifactDir(dir.resolve("spaces").toString());
        props.setHostedEnabled(true);   // 配了也不算：这不是生产 profile
        WorkspaceRegistry registry = new WorkspaceRegistry(props, new ObjectMapper(), dir.resolve("state.json").toString(), "127.0.0.1", "");
        WorkspaceController c = new WorkspaceController(registry, dialog, evil);
        as(88);
        assertThrows(BusinessException.class, () -> c.updateSettings(Map.of("mode", "EXEC", "root", "")));
        assertFalse(registry.service(88L).access().enabled());
    }

    @Test
    @DisplayName("本机的普通账号：不选文件夹也能开档位，就是生成到产物")
    void 本机不选文件夹() throws Exception {
        WorkspaceController c = controller("");
        as(99);
        Map<String, Object> on = data(c.updateSettings(Map.of("mode", "WRITE", "root", "")));
        assertEquals("WRITE", on.get("effectiveMode"));
        assertEquals(true, on.get("artifactMode"));
        assertEquals(false, on.get("artifactOnly"));
    }
}
