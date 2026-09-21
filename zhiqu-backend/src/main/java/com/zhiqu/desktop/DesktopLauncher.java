package com.zhiqu.desktop;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.context.annotation.Profile;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

/**
 * 桌面应用形态：双击启动之后把界面打开。<b>只在 {@code desktop} profile 下生效。</b>
 *
 * <h2>为什么桌面版必须把后端装在应用里，而不能只是一个指向服务器的窗口</h2>
 *
 * <p>代码工作区（coding agent 读你磁盘上的项目）有一条硬前置：{@code server.address}
 * 必须是回环地址。理由见 {@code WorkspaceAccess} —— 一个能读你硬盘的服务不能监听公网。
 *
 * <p>所以远程服务器上的那一份<b>永远不会</b>有工作区能力（那也是对的：服务器上没有你的代码，
 * 而且多用户实例里谁都不该读到它的磁盘）。要用 coding agent，后端就得在你自己的机器上跑。
 *
 * <h2>数据在哪</h2>
 *
 * <p>不在应用里。{@code spring.datasource.*} 指向哪就存在哪 —— 指向远程 MySQL，
 * 换台机器装同一个应用、登录同一个账号，看到的就是同一份数据。
 *
 * <p><b>但不要把 MySQL 直接暴露到公网。</b>正经做法是数据库只监听内网，桌面端通过
 * SSH 隧道或 WireGuard 连过去。这不是可选的谨慎 —— 开在公网的 3306 会被扫到。
 *
 * <h2>这一版打开的是系统浏览器，不是内嵌窗口</h2>
 *
 * <p>说清楚现状：你会得到一个真正的应用图标、双击即启动、后端在里面 —— 但界面是在
 * 默认浏览器里打开的。要完全脱离浏览器观感需要内嵌 WebView（JavaFX），
 * 那会给每个平台各加约 60MB 依赖，单独做。
 */
@Component
@Profile("desktop")
public class DesktopLauncher {
    private static final Logger log = LoggerFactory.getLogger(DesktopLauncher.class);

    /** 就绪后要打开的页面。 */
    static final String LANDING_PAGE = "/dashboard.html";

    /**
     * 原生外壳通过这个系统属性把「端口写到哪」告诉后端。
     *
     * <p>设了它就说明<b>有人替我们负责显示界面</b>（macOS 上那个 WKWebView 外壳），
     * 于是后端不再去弹系统浏览器 —— 否则用户会同时得到一个应用窗口和一个浏览器标签页。
     */
    static final String PORT_FILE_PROPERTY = "zhiqu.desktop.port-file";

    private final BrowserOpener browserOpener;

    private volatile String openedUrl;

    public DesktopLauncher(BrowserOpener browserOpener) {
        this.browserOpener = browserOpener;
    }

    /**
     * 取端口、开界面 —— <b>同一个回调里做完</b>。
     *
     * <p>这里原本是两段：一个 {@code @EventListener(ApplicationReadyEvent.class)} 负责把
     * 端口记下来，一个 {@code ApplicationRunner.run()} 负责打开浏览器。
     * 而 Spring Boot 的顺序是 <b>先 {@code callRunners()}，再发 {@code ApplicationReadyEvent}</b> ——
     * 也就是说 {@code run()} 执行时端口还是 {@code -1}，每一次都走「拿不到实际端口，
     * 跳过自动打开界面」那条 return。浏览器一次都没有被尝试打开过。
     *
     * <p>这个 bug 躲过了一次「完整验证」：那次验证查的是 HTTP 通不通、绑的是不是回环、
     * 迁移跑没跑完 —— 全都通过了，因为后端确实是好的。没被查的恰恰是这个类唯一的职责。
     * 所以现在打开动作走 {@link BrowserOpener}，{@link #openedUrl()} 把结果暴露出来，
     * 让判据能直接断言它。
     *
     * <p>端口从<b>实际启动的 Web 服务器</b>上取，不从配置里读：桌面版默认让系统分配端口
     * （{@code server.port=0}），配置里写死多少和实际监听在哪是两件事。
     */
    @EventListener(ApplicationReadyEvent.class)
    public void openWhenReady(ApplicationReadyEvent event) {
        int port = actualPort(event);
        if (port <= 0) {
            log.warn("拿不到实际端口，跳过自动打开界面");
            return;
        }
        String url = "http://127.0.0.1:" + port + LANDING_PAGE;
        log.info("桌面版已就绪：{}", url);
        openedUrl = url;

        String portFile = System.getProperty(PORT_FILE_PROPERTY);
        if (portFile != null && !portFile.isBlank()) {
            handOffToShell(portFile, port);
            return;
        }

        // 没有外壳接手，退回「开系统浏览器」。这条路仍然要留着：
        // 直接 `java -jar --spring.profiles.active=desktop` 跑的时候没有外壳。
        // Dock 图标无限弹跳的修法，理由见 DockPresence。放在开浏览器之前，
        // 因为弹跳是用户在等页面的那几秒里唯一看得见的东西。
        DockPresence.settle(System.getProperty("os.name", ""));
        if (!browserOpener.open(url)) {
            log.info("请手动在浏览器里打开：{}", url);
        }
    }

    /**
     * 把端口写给原生外壳，<b>不开浏览器</b>。
     *
     * <p>先写临时文件再原子改名：外壳是轮询这个文件的，直接写的话它可能读到一个
     * 只写了一半的数字（"63" 而不是 "63187"），然后连到别人的端口上去。
     *
     * <p>写失败不能让启动崩掉 —— 后端本身是好的，用户至少还能从日志里拿到地址。
     */
    private void handOffToShell(String portFile, int port) {
        Path target = Path.of(portFile);
        try {
            Path parent = target.toAbsolutePath().getParent();
            Path tmp = Files.createTempFile(parent, "zhiqu-port", ".tmp");
            Files.writeString(tmp, Integer.toString(port), StandardCharsets.UTF_8);
            try {
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
            }
            log.info("端口已交给原生外壳：{} → {}", port, target);
        } catch (IOException e) {
            log.warn("写端口文件失败，原生外壳可能起不来界面：{} —— {}", target, e.toString());
        }
    }

    /** 实际监听的端口；取不到返回 -1。 */
    private static int actualPort(ApplicationReadyEvent event) {
        if (event.getApplicationContext() instanceof WebServerApplicationContext web
                && web.getWebServer() != null) {
            return web.getWebServer().getPort();
        }
        return -1;
    }

    /**
     * 这一次启动实际打开（或试图打开）的地址；没走到那一步则为 {@code null}。
     *
     * <p>存在的唯一理由是让判据能看见这件事发生过 —— 见 {@link BrowserOpener} 的类注释。
     */
    public String openedUrl() {
        return openedUrl;
    }
}
