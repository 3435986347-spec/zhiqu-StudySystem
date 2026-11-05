package com.zhiqu.service.workspace;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 弹系统的文件夹选择框（第一百零五轮，用户：「点击选择文件夹应该直接打开系统的文件夹和文件页面」）。
 *
 * <p>后端和用户在同一台电脑上（工作区只在回环地址上生效，调用方已经判过），所以由后端起系统自带的小程序弹框：
 * 网页版和桌面应用同一条路，外壳不用改。路径不拼进脚本，走参数 / 环境变量。
 * 弹不了（Linux 没装 zenity、没有图形界面）就说清楚，前端退回页面里的选择器。
 */
@Component
public class WorkspaceFolderDialog {

    private static final Logger log = LoggerFactory.getLogger(WorkspaceFolderDialog.class);
    private static final String PROMPT = "选择项目文件夹";
    private static final long TIMEOUT_SECONDS = 600;
    /** 子进程不继承环境变量（那里可能有密钥），只给弹框要用的 */
    private static final List<String> ENV_KEEP = List.of("PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "__CF_USER_TEXT_ENCODING",
            "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
            "SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA");
    static final String START_ENV = "ZHIQU_PICK_START";

    /** 三选一：选了（path）、取消了 / 已经开着一个（都什么都不做）、弹不了（unavailable 说为什么） */
    public record Pick(String path, boolean cancelled, String unavailable) {
        static Pick chosen(String path) {
            return new Pick(path, false, null);
        }

        static Pick cancel() {
            return new Pick(null, true, null);
        }

        static Pick cannot(String why) {
            return new Pick(null, false, why);
        }
    }

    private final AtomicBoolean open = new AtomicBoolean();

    public Pick pick(String start) {
        String os = System.getProperty("os.name", "");
        if (isLinux(os) && System.getenv("DISPLAY") == null && System.getenv("WAYLAND_DISPLAY") == null) {
            return Pick.cannot("这台机器没有图形界面");
        }
        String from = usableStart(start);
        return run(command(os, from), from, TIMEOUT_SECONDS);
    }

    private static boolean isLinux(String os) {
        String name = os.toLowerCase(Locale.ROOT);
        return !name.contains("mac") && !name.contains("win");
    }

    /** 从哪儿开始选：只认存在的目录（macOS 的 default location 给不存在的路径会直接报错） */
    static String usableStart(String start) {
        if (start == null || start.isBlank()) return "";
        try {
            return Files.isDirectory(Path.of(start.trim())) ? start.trim() : "";
        } catch (InvalidPathException e) {
            return "";
        }
    }

    static List<String> command(String osName, String start) {
        String name = osName.toLowerCase(Locale.ROOT);
        if (name.contains("mac")) {
            List<String> cmd = new ArrayList<>(List.of("/usr/bin/osascript",
                    "-e", "on run argv",
                    "-e", "tell me to activate",
                    "-e", "if (count of argv) > 0 then",
                    "-e", "return POSIX path of (choose folder with prompt \"" + PROMPT + "\" default location (POSIX file (item 1 of argv)))",
                    "-e", "end if",
                    "-e", "return POSIX path of (choose folder with prompt \"" + PROMPT + "\")",
                    "-e", "end run"));
            if (!start.isEmpty()) cmd.add(start);
            return cmd;
        }
        if (name.contains("win")) {
            // 路径走环境变量（ZHIQU_PICK_START），不拼进命令；隐藏的 TopMost 窗口当父窗口，框才不会压在浏览器后面
            return List.of("powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command",
                    "Add-Type -AssemblyName System.Windows.Forms;"
                            + "$o=New-Object System.Windows.Forms.Form -Property @{TopMost=$true;ShowInTaskbar=$false;Opacity=0};"
                            + "$d=New-Object System.Windows.Forms.FolderBrowserDialog;$d.Description='" + PROMPT + "';"
                            + "if($env:" + START_ENV + "){$d.SelectedPath=$env:" + START_ENV + "};"
                            + "if($d.ShowDialog($o) -eq 'OK'){[Console]::OutputEncoding=[Text.Encoding]::UTF8;[Console]::Out.Write($d.SelectedPath)}");
        }
        List<String> cmd = new ArrayList<>(List.of("zenity", "--file-selection", "--directory", "--title=" + PROMPT));
        if (!start.isEmpty()) cmd.add("--filename=" + (start.endsWith("/") ? start : start + "/"));
        return cmd;
    }

    /** 一次只开一个：连点两下不弹两个框，第二下当没点 */
    Pick run(List<String> command, String start, long timeoutSeconds) {
        if (!open.compareAndSet(false, true)) return Pick.cancel();
        Process process = null;
        try {
            ProcessBuilder builder = new ProcessBuilder(command);
            Map<String, String> env = builder.environment();
            Map<String, String> inherited = Map.copyOf(env);
            env.clear();
            for (String key : ENV_KEEP) {
                if (inherited.containsKey(key)) env.put(key, inherited.get(key));
            }
            if (!start.isEmpty()) env.put(START_ENV, start);
            process = builder.start();
            process.getOutputStream().close();
            if (!process.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
                process.destroyForcibly();
                return Pick.cancel();
            }
            String out = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
            String err = new String(process.getErrorStream().readAllBytes(), StandardCharsets.UTF_8).trim();
            return interpret(process.exitValue(), out, err);
        } catch (IOException e) {
            log.info("弹不了系统的文件夹选择框：{}", e.getMessage());
            return Pick.cannot("这台机器弹不了系统的文件夹选择框");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            if (process != null) process.destroyForcibly();
            return Pick.cancel();
        } finally {
            open.set(false);
        }
    }

    static Pick interpret(int exit, String out, String err) {
        if (exit == 0) {
            if (out.isEmpty()) return Pick.cancel();   // Windows 取消：退出码 0、什么都不打
            String path = out.length() > 1 && out.endsWith("/") ? out.substring(0, out.length() - 1) : out;
            try {
                if (Files.isDirectory(Path.of(path))) return Pick.chosen(path);
            } catch (InvalidPathException e) {
                log.info("选择框给了认不出的路径：{}", path);
            }
            return Pick.cannot("选择框给的不是一个文件夹：" + path);
        }
        // 用户取消：macOS 报 execution error …(-128)、zenity 退出码 1。别的 execution error 才是真出错（比如没有权限）
        if (exit == 1 && (!err.contains("execution error") || err.contains("-128"))) return Pick.cancel();
        log.info("系统的文件夹选择框出错（退出码 {}）：{}", exit, err);
        return Pick.cannot("系统的文件夹选择框出错：" + (err.length() > 200 ? err.substring(0, 200) : err));
    }
}
