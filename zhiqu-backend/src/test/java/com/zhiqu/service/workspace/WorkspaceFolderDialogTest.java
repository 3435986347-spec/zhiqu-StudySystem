package com.zhiqu.service.workspace;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 弹系统的文件夹选择框（第一百零五轮）。真弹框要人点（也不该在跑测试时弹到用户屏幕上），
 * 这里用 /bin/sh 冒充那个小程序：怎么起、结果怎么认都是真的；三个系统的命令长什么样单独钉着。
 */
class WorkspaceFolderDialogTest {

    private final WorkspaceFolderDialog dialog = new WorkspaceFolderDialog();

    private static List<String> sh(String script) {
        return List.of("/bin/sh", "-c", script);
    }

    @Test
    @DisplayName("macOS：choose folder，起始路径走参数、不拼进脚本（路径里有引号也弹得出来，也注入不了）")
    void macOS的命令(@TempDir Path dir) {
        String weird = dir.toString() + "/a\"; do shell script \"rm -rf x";
        List<String> cmd = WorkspaceFolderDialog.command("Mac OS X", weird);
        assertEquals("/usr/bin/osascript", cmd.get(0));
        assertEquals(weird, cmd.get(cmd.size() - 1), "起始路径应当是最后一个参数");
        String script = String.join("\n", cmd.subList(1, cmd.size() - 1));
        assertTrue(script.contains("choose folder") && script.contains("POSIX path of") && script.contains("tell me to activate"), script);
        assertFalse(script.contains(weird), "路径拼进脚本了");
        assertTrue(WorkspaceFolderDialog.command("Mac OS X", "").stream().noneMatch(a -> a.isEmpty()), "没有起始路径时不该传空参数");
    }

    @Test
    @DisplayName("Windows：FolderBrowserDialog（要 STA），路径走环境变量；Linux：zenity 选目录")
    void 别的系统的命令() {
        List<String> win = WorkspaceFolderDialog.command("Windows 11", "C:\\Users\\me\\a'b");
        assertEquals("powershell.exe", win.get(0));
        assertTrue(win.contains("-STA"), "FolderBrowserDialog 要 STA，不然弹不出来：" + win);
        String script = win.get(win.size() - 1);
        assertTrue(script.contains("FolderBrowserDialog") && script.contains("$env:" + WorkspaceFolderDialog.START_ENV) && script.contains("TopMost=$true"), script);
        assertFalse(script.contains("a'b"), "路径拼进命令了");
        List<String> linux = WorkspaceFolderDialog.command("Linux", "/home/me");
        assertEquals(List.of("zenity", "--file-selection", "--directory", "--title=选择项目文件夹", "--filename=/home/me/"), linux);
    }

    @Test
    @DisplayName("起始路径只认存在的目录（macOS 给不存在的路径会直接报错，框都不弹）")
    void 起始路径(@TempDir Path dir) throws Exception {
        assertEquals(dir.toString(), WorkspaceFolderDialog.usableStart(dir.toString()));
        assertEquals("", WorkspaceFolderDialog.usableStart(dir.resolve("没有这个").toString()));
        Path file = Files.writeString(dir.resolve("f.txt"), "x");
        assertEquals("", WorkspaceFolderDialog.usableStart(file.toString()));
        assertEquals("", WorkspaceFolderDialog.usableStart(""));
        assertEquals("", WorkspaceFolderDialog.usableStart(null));
    }

    @Test
    @DisplayName("选了：给路径（去掉结尾的 /，中文路径不乱码）；给的不是文件夹不信")
    void 选了(@TempDir Path dir) throws Exception {
        Path chinese = Files.createDirectory(dir.resolve("中文 项目"));
        WorkspaceFolderDialog.Pick pick = dialog.run(sh("printf '%s/\\n' '" + chinese + "'"), "", 10);
        assertEquals(chinese.toString(), pick.path());
        assertFalse(pick.cancelled());
        assertNull(pick.unavailable());
        WorkspaceFolderDialog.Pick notDir = dialog.run(sh("echo /没有这个文件夹"), "", 10);
        assertNull(notDir.path());
        assertNotNull(notDir.unavailable());
    }

    @Test
    @DisplayName("取消什么都不做：macOS 报 -128、zenity 退出码 1、Windows 退出码 0 不打字；真出错（没有权限）才算弹不了，退回页面里的选择器")
    void 取消和出错() {
        assertTrue(dialog.run(sh("echo '0:30: execution error: User canceled. (-128)' >&2; exit 1"), "", 10).cancelled());
        assertTrue(dialog.run(sh("exit 1"), "", 10).cancelled());
        assertTrue(dialog.run(sh("exit 0"), "", 10).cancelled());
        WorkspaceFolderDialog.Pick denied = dialog.run(sh("echo '0:30: execution error: Not authorized. (-1743)' >&2; exit 1"), "", 10);
        assertFalse(denied.cancelled());
        assertTrue(denied.unavailable().contains("-1743"), denied.unavailable());
        WorkspaceFolderDialog.Pick crashed = dialog.run(sh("exit 2"), "", 10);
        assertFalse(crashed.cancelled());
        assertNotNull(crashed.unavailable());
    }

    @Test
    @DisplayName("小程序不存在（Linux 没装 zenity）：说弹不了，不抛异常")
    void 没有那个小程序() {
        WorkspaceFolderDialog.Pick pick = dialog.run(List.of("/没有这个程序/zenity"), "", 10);
        assertNull(pick.path());
        assertNotNull(pick.unavailable());
    }

    @Test
    @DisplayName("一直不选：到时间杀掉，当取消；杀完下一次还能弹")
    void 一直不选(@TempDir Path dir) throws Exception {
        Path pidFile = dir.resolve("pid");
        long started = System.nanoTime();
        assertTrue(dialog.run(sh("echo $$ > '" + pidFile + "'; exec sleep 30"), "", 1).cancelled());
        assertTrue(TimeUnit.NANOSECONDS.toSeconds(System.nanoTime() - started) < 10, "没有按时等到");
        long pid = Long.parseLong(Files.readString(pidFile).trim());
        for (int i = 0; i < 100 && ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false); i++) Thread.sleep(20);
        assertFalse(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false), "到时间没杀掉，框还开着");
        assertTrue(dialog.run(sh("exit 0"), "", 10).cancelled(), "杀完应当还能再弹");
    }

    @Test
    @DisplayName("连点两下只弹一个：第二下当没点（取消），不再起一个")
    void 只弹一个(@TempDir Path dir) throws Exception {
        Path ran = dir.resolve("ran.txt");
        String script = "echo x >> '" + ran + "'; exec sleep 3";
        CompletableFuture<WorkspaceFolderDialog.Pick> first = CompletableFuture.supplyAsync(() -> dialog.run(sh(script), "", 1));
        for (int i = 0; i < 100 && !Files.exists(ran); i++) Thread.sleep(20);
        assertTrue(Files.exists(ran), "第一个没起来");
        assertTrue(dialog.run(sh(script), "", 1).cancelled());
        first.get(10, TimeUnit.SECONDS);
        assertEquals(1, Files.readAllLines(ran).size(), "弹了两个");
    }

    @Test
    @DisplayName("子进程不继承环境变量（那里可能有密钥），只给弹框要用的；起始路径走环境变量")
    void 环境变量(@TempDir Path dir) throws Exception {
        String inherited = System.getenv().keySet().stream()
                .filter(k -> !List.of("PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "__CF_USER_TEXT_ENCODING", "PWD", "SHLVL", "_", "OLDPWD").contains(k) && k.matches("[A-Z_]+"))
                .findFirst().orElse(null);
        org.junit.jupiter.api.Assumptions.assumeTrue(inherited != null, "这个进程没有别的环境变量可比");
        Path envFile = dir.resolve("env.txt");
        dialog.run(sh("env > '" + envFile + "'; printf '%s' \"$" + WorkspaceFolderDialog.START_ENV + "\""), dir.toString(), 10);
        String env = Files.readString(envFile, StandardCharsets.UTF_8);
        assertTrue(env.contains(WorkspaceFolderDialog.START_ENV + "=" + dir), env);
        assertFalse(env.contains(inherited + "="), inherited + " 被子进程继承了");
    }
}
