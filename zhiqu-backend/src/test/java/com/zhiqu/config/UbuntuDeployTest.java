package com.zhiqu.config;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import com.zhiqu.SourceText;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 第一百一十九轮：线上用的那份部署（{@code deploy/ubuntu/}）里不能丢的东西。
 *
 * <p>这些全是安全边界或者在真服务器上撞出来的，丢了一条服务照样起得来、页面照样能打开，只是门没了。
 */
class UbuntuDeployTest {

    private static final Path DIR = Path.of("..", "deploy", "ubuntu");

    private static String read(String name) throws Exception {
        return Files.readString(DIR.resolve(name));
    }

    /** 去掉整行注释：判据不能被注释里提到的字骗过 */
    private static String code(String name) throws Exception {
        StringBuilder out = new StringBuilder();
        for (String line : read(name).split("\n")) {
            if (!line.stripLeading().startsWith("#")) {
                out.append(line).append('\n');
            }
        }
        return out.toString();
    }

    @Test
    @DisplayName("配置模板：application.yml 的键一个不漏（生产配置是替换不是追加）")
    void 模板不漏键() throws Exception {
        Set<String> dev = ProdConfigParityTest.leafKeys(Files.readString(Path.of("src/main/resources/application.yml")));
        Set<String> prod = ProdConfigParityTest.leafKeys(read("application-prod.example.yml"));
        assertTrue(dev.size() >= 40 && prod.size() >= 40, "解析出的键太少，判据在空转：dev=" + dev.size() + " prod=" + prod.size());
        Set<String> missing = new TreeSet<>(dev);
        missing.removeAll(prod);
        assertEquals(Set.of(), missing);
    }

    @Test
    @DisplayName("配置模板：生产 profile、只听本机、跑命令默认关（跑过隔离判据才开）、密钥全是占位符、路径在 Linux 上")
    void 模板里的边界() throws Exception {
        Set<String> keys = ProdConfigParityTest.leafKeys(read("application-prod.example.yml"));
        assertTrue(keys.contains("spring.profiles.active"), "磁盘接口、执行、密钥校验的门都看 profile");
        String yml = code("application-prod.example.yml");
        assertTrue(yml.contains("active: prod"));
        assertTrue(yml.contains("address: 127.0.0.1"), "应用不能直接对外，Caddy 是唯一的入口");
        assertTrue(yml.contains("hosted-enabled: true"));
        assertTrue(yml.contains("hosted-shell-enabled: false"), "模板里要关着：verify-hosted-shell.sh 全过了才打开");
        assertTrue(yml.contains("block-private-network: true"));
        for (String mark : List.of("CHANGE_ME_DB_PASSWORD", "CHANGE_ME_REDIS_PASSWORD", "CHANGE_ME_TO_A_LONG_RANDOM_SECRET_AT_LEAST_32_CHARS",
                "CHANGE_ME_TO_A_LONG_RANDOM_CRYPTO_MASTER_KEY", "CHANGE_ME_RAG_SERVICE_TOKEN")) {
            assertTrue(yml.contains(mark), mark + " 没了：install.sh 就没有地方填这个密钥");
            // 对照替换表本身：同一个占位符在建库那行也出现，只看「提到了」会被骗过（扰动撞出来的）
            assertTrue(code("install.sh").contains("'" + mark + "': 'ZQ_"), "install.sh 没有替换 " + mark + "：照占位符起，服务会拒绝启动");
        }
        assertFalse(yml.contains("C:/"), "Windows 的路径");
    }

    @Test
    @DisplayName("systemd 单元：专门的账号（ubuntu 有免密 sudo）、生产 profile、内存上限、杀一条命令不停整个服务；不加会挡住 bubblewrap 的选项")
    void 单元里的边界() throws Exception {
        String unit = code("zhiqu-backend.service");
        assertTrue(unit.contains("User=zhiqu\n"), "所有注册用户都能叫起命令的进程，不能跑在有免密 sudo 的账号下");
        assertTrue(unit.contains("--spring.profiles.active=prod"), "这是安全边界");
        assertTrue(unit.contains("MemoryMax="));
        assertTrue(unit.contains("OOMPolicy=continue"), "默认是 stop：杀掉沙箱里的一条命令，systemd 就把整个服务停了");
        assertTrue(unit.contains("NoNewPrivileges=true"));
        assertTrue(unit.contains("ProtectSystem=strict"));
        for (String blocked : List.of("ProtectKernelTunables", "ProtectProc", "ProcSubset", "PrivateDevices", "RestrictNamespaces")) {
            assertFalse(unit.contains(blocked), blocked + " 会让 bubblewrap 起不来");
        }
        String verify = code("verify-hosted-shell.sh");
        for (String line : unit.split("\n")) {
            if (line.startsWith("MemoryMax=") || line.startsWith("TasksMax=") || line.startsWith("ProtectSystem=") || line.startsWith("OOMPolicy=")) {
                assertTrue(verify.contains("-p " + line), "隔离判据要在和服务同样的限制下跑，少了 " + line);
            }
        }
    }

    @Test
    @DisplayName("隔离判据的门：跳过不算过、到点算没过；全过才打开")
    void 判据的门() throws Exception {
        String verify = code("verify-hosted-shell.sh");
        assertTrue(verify.contains("${SKIP:-1}\" != 0"), "这台机器探测不到 bubblewrap 时判据全跳过：跳过不能算过（真服务器上第一次跑就是 16 条跳过）");
        assertTrue(verify.contains("${FAIL:-1}\" != 0"));
        assertTrue(verify.contains("RuntimeMaxSec="), "漏掉的进程攥着管道，判据会一直等下去（真服务器上等过）");
        assertTrue(verify.contains("-p User=zhiqu"));
        int gate = verify.indexOf("exit 1\nfi\nrm -f \"$RESULT\"");
        int flip = verify.indexOf("hosted-shell-enabled:");
        assertTrue(gate > 0 && flip > gate, "没过就退出，要在改配置之前");
    }

    @Test
    @DisplayName("AppArmor：不再加一份绑在 bwrap 上的配置（和系统自带的冲突，哪份都不生效）；密钥不走命令行；已有配置不重写（主密钥一换密文就解不开）")
    void 安装脚本() throws Exception {
        String install = code("install.sh");
        assertFalse(Files.exists(DIR.resolve("apparmor-bwrap")), "两份配置绑同一个程序，内核算冲突");
        assertFalse(install.contains("install -m 644 \"$HERE/apparmor"), "不要再装一份");
        assertTrue(install.contains("if [ -f \"$CONFIG\" ]; then"), "配置存在就不动");
        assertFalse(install.contains("--password") || install.contains("-p$"), "密码不进命令行参数");
        assertTrue(install.contains("--shell /usr/sbin/nologin"));
        assertTrue(install.contains("loop,nodev,nosuid"), "临时空间要是单独一块文件系统：命令写满了也不影响 MySQL");
    }

    /** Caddyfile 顶层的站点块：地址 → 块里的内容（每行去掉缩进） */
    static Map<String, String> sites(String caddyfile) {
        Map<String, String> out = new LinkedHashMap<>();
        String head = null;
        StringBuilder body = new StringBuilder();
        int depth = 0;
        for (String line : caddyfile.split("\n")) {
            String t = line.strip();
            if (depth == 0 && t.endsWith("{")) {
                head = t.substring(0, t.length() - 1).strip();
                body = new StringBuilder();
            } else if (depth > 0) {
                body.append(t).append('\n');
            }
            depth += t.chars().filter(c -> c == '{').count() - t.chars().filter(c -> c == '}').count();
            if (depth == 0 && head != null) {
                out.put(head, body.toString());
                head = null;
            }
        }
        return out;
    }

    /** 后端所有的流式接口（返回 SseEmitter 或 produces text/event-stream）：类上的前缀 + 方法上的路径 */
    static Set<String> streamEndpoints() throws Exception {
        Pattern classMapping = Pattern.compile("@RequestMapping\\(\"([^\"]*)\"\\)\\s*public\\s+class");
        Pattern method = Pattern.compile("@(?:Get|Post)Mapping\\((?:value\\s*=\\s*)?\"([^\"]*)\"([^)]*)\\)\\s*(?:@\\w+(?:\\([^)]*\\))?\\s*)*public\\s+([\\w<>?, ]+?)\\s+\\w+\\(");
        Set<String> out = new TreeSet<>();
        try (var files = Files.list(Path.of("src/main/java/com/zhiqu/controller"))) {
            for (Path file : files.filter(p -> p.toString().endsWith(".java")).toList()) {
                String src = SourceText.stripComments(Files.readString(file));
                Matcher c = classMapping.matcher(src);
                String prefix = c.find() ? c.group(1) : "";
                Matcher m = method.matcher(src);
                while (m.find()) {
                    if (m.group(3).contains("SseEmitter") || m.group(2).contains("EVENT_STREAM")) {
                        out.add(prefix + m.group(1));
                    }
                }
            }
        }
        return out;
    }

    @Test
    @DisplayName("Caddy：只有一个源（www 只跳转，不然登录和 Service Worker 各算各的）；后端每个流式接口都不缓冲")
    void 反向代理() throws Exception {
        Map<String, String> sites = sites(code("Caddyfile"));
        assertTrue(sites.size() >= 2, "解析出的站点块太少，判据在空转：" + sites.keySet());
        List<String> app = sites.entrySet().stream().filter(e -> e.getValue().contains("reverse_proxy")).map(Map.Entry::getKey).toList();
        assertEquals(List.of("zhiqustudy.com"), app, "应用只挂在一个地址上：www 也挂应用的话，用户在 www 登录了换到主域名还得再登");
        String www = sites.get("www.zhiqustudy.com");
        assertTrue(www != null && www.contains("redir https://zhiqustudy.com{uri} permanent\n"), "www 要跳到主域名：" + sites.keySet());

        String main = sites.get("zhiqustudy.com");
        Matcher sse = Pattern.compile("(?m)^@sse path (.+)$").matcher(main);
        assertTrue(sse.find(), "没有 @sse 的匹配");
        Set<String> proxied = new TreeSet<>(List.of(sse.group(1).strip().split("\\s+")));
        Set<String> streams = streamEndpoints();
        assertTrue(streams.size() >= 4, "找到的流式接口太少，判据在空转：" + streams);
        assertEquals(streams, proxied, "Caddyfile 的 @sse 要和后端的流式接口一一对上");
        assertTrue(main.contains("reverse_proxy @sse 127.0.0.1:8080 {\nflush_interval -1\n}"), "@sse 要不缓冲");
    }

    @Test
    @DisplayName("脚本语法都对（bash -n）")
    void 脚本语法() throws Exception {
        try (var files = Files.list(DIR)) {
            List<Path> scripts = files.filter(p -> p.toString().endsWith(".sh")).toList();
            assertTrue(scripts.size() >= 4, "只找到 " + scripts);
            for (Path script : scripts) {
                Process p = new ProcessBuilder("bash", "-n", script.toString()).redirectErrorStream(true).start();
                String out = new String(p.getInputStream().readAllBytes());
                assertEquals(0, p.waitFor(), script + "：" + out);
            }
        }
    }
}
