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

    // ── 生成到产物（第一百一十六轮）──────────────────────────

    private WorkspaceProperties artifactProps(boolean hosted) {
        WorkspaceProperties props = new WorkspaceProperties();
        props.setArtifactDir(dir.resolve("spaces").toString());
        props.setHostedEnabled(hosted);
        return props;
    }

    @Test
    @DisplayName("本机：档位开着、没选文件夹就是生成到产物；一段对话一个临时空间，账号之间、对话之间都分开；选了文件夹就还是文件夹")
    void 本机没选文件夹生成到产物() throws Exception {
        WorkspaceRegistry r = registry(artifactProps(false), "127.0.0.1", "");
        r.service(1L).applySettings("EXEC", "");
        assertTrue(r.service(1L).access().artifactMode());
        assertTrue(r.service(1L).access().enabled());
        WorkspaceRegistry.CodeTarget one = r.target(1L, 10L);
        assertTrue(one.artifact());
        Path root = one.service().access().root();
        assertTrue(Files.isDirectory(root), "临时空间要建好");
        assertEquals(dir.resolve("spaces").resolve("1").resolve("10").toRealPath(), root);
        if (java.nio.file.FileSystems.getDefault().supportedFileAttributeViews().contains("posix")) {
            assertEquals("rwx------", java.nio.file.attribute.PosixFilePermissions.toString(Files.getPosixFilePermissions(dir.resolve("spaces"))), "别的系统账号进不来");
        }
        assertEquals(WorkspaceMode.EXEC, one.service().access().effectiveMode());
        assertTrue(one.executor().enabled(), "桌面版的临时空间能跑命令（沿用系统沙箱）");
        assertFalse(root.equals(r.target(1L, 11L).service().access().root()), "另一段对话是另一个空间");
        r.service(2L).applySettings("READ", "");
        assertFalse(root.equals(r.target(2L, 10L).service().access().root()), "另一个账号是另一个空间");
        assertFalse(r.target(2L, 10L).executor().enabled(), "只读的档位跑不了");
        assertTrue(r.target(1L, null).service().access().root().endsWith("default"), "不知道是哪段对话：按账号放一个");

        Path folder = folder("project");
        r.service(1L).applySettings("WRITE", folder.toString());
        assertFalse(r.service(1L).access().artifactMode());
        WorkspaceRegistry.CodeTarget mine = r.target(1L, 10L);
        assertFalse(mine.artifact());
        assertEquals(folder, mine.service().access().root());

        r.service(3L).applySettings("OFF", "");
        assertFalse(r.service(3L).access().enabled());
        assertFalse(r.target(3L, 10L).artifact(), "关着的不算");

        r.deleteSpace(1L, 10L);
        assertFalse(Files.exists(root), "对话删了空间也删");
    }

    @Test
    @DisplayName("没绑回环的后端：配了档位也不会变成生成到产物（局域网里的人不能在这台电脑上跑命令）")
    void 没绑回环不给产物() throws Exception {
        WorkspaceRegistry r = registry(artifactProps(false), "0.0.0.0", "");
        assertFalse(r.artifactAllowed());
        r.service(1L).applySettings("EXEC", "");
        assertFalse(r.service(1L).access().artifactMode());
        assertFalse(r.service(1L).access().enabled());
    }

    @Test
    @DisplayName("服务器默认关：hosted-enabled 没开就和原来一样什么都没有")
    void 服务器默认关() throws Exception {
        WorkspaceRegistry prod = registry(artifactProps(false), "127.0.0.1", "prod");
        assertFalse(prod.artifactOnly());
        assertFalse(prod.artifactAllowed());
        prod.service(1L).applySettings("EXEC", "");
        assertFalse(prod.service(1L).access().enabled());
        assertNotNull(prod.service(1L).access().refusalReason());
    }

    @Test
    @DisplayName("服务器打开之后：只有产物，写了文件夹也不看；这一轮还跑不了命令（下一轮才有隔离）；磁盘的入口照旧关着")
    void 服务器打开之后只有产物() throws Exception {
        WorkspaceRegistry prod = registry(artifactProps(true), "127.0.0.1", "prod");
        assertTrue(prod.artifactOnly());
        Path secret = folder("server-secrets");
        prod.service(1L).applySettings("EXEC", secret.toString());
        assertTrue(prod.service(1L).access().artifactMode(), "写了目录也不当文件夹");
        assertNull(prod.service(1L).access().root());
        WorkspaceRegistry.CodeTarget t = prod.target(1L, 5L);
        assertTrue(t.artifact());
        assertFalse(t.service().access().root().startsWith(secret));
        assertFalse(t.executor().enabled(), "生产 profile 还是不执行");
        assertFalse(t.executor().shellEnabled());
        assertFalse(prod.localDiskAllowed());
        assertFalse(prod.openByDefault());
        prod.service(2L).applySettings("OFF", "");
        assertFalse(prod.service(2L).access().enabled(), "账号自己没开就是关的");
    }

    @Test
    @DisplayName("临时空间清理：几天没动的删，还在用的留着（里面的文件新也算），软链不跟")
    void 清理临时空间() throws Exception {
        WorkspaceProperties props = artifactProps(false);
        props.setArtifactRetentionDays(3);
        Path base = dir.resolve("spaces");
        Path idle = Files.createDirectories(base.resolve("1/10"));
        Path active = Files.createDirectories(base.resolve("1/11"));
        Path outside = folder("outside");
        Files.writeString(outside.resolve("keep.txt"), "别删我");
        Files.writeString(idle.resolve("old.txt"), "x");
        Files.createSymbolicLink(idle.resolve("link"), outside);
        Files.writeString(active.resolve("new.txt"), "x");
        long now = System.currentTimeMillis();
        java.nio.file.attribute.FileTime old = java.nio.file.attribute.FileTime.fromMillis(now - java.time.Duration.ofDays(5).toMillis());
        for (Path p : java.util.List.of(idle.resolve("old.txt"), idle, active)) {
            Files.setLastModifiedTime(p, old);
        }
        // 刚建的软链和 new.txt 都是「现在」。idle 的软链改不了时间（Java 没有 lutimes），删掉它之后再试一次软链不跟的那种
        Files.delete(idle.resolve("link"));
        Files.setLastModifiedTime(idle, old);   // 删软链刷新了目录的时间
        Path idle2 = Files.createDirectories(base.resolve("1/12"));
        Files.setLastModifiedTime(idle2, old);
        assertEquals(2, new ArtifactSpaces(props).clean(now));
        assertFalse(Files.exists(idle));
        assertFalse(Files.exists(idle2));
        assertTrue(Files.exists(active.resolve("new.txt")), "里面的文件是新的就还在用");
        // deleteTree 碰到软链只删软链
        Path withLink = Files.createDirectories(base.resolve("1/13"));
        Files.createSymbolicLink(withLink.resolve("link"), outside);
        ArtifactSpaces.deleteTree(withLink);
        assertFalse(Files.exists(withLink));
        assertTrue(Files.exists(outside.resolve("keep.txt")), "软链指向的东西不能被删");
    }
}
