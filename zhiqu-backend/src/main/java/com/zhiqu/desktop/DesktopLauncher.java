package com.zhiqu.desktop;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.context.annotation.Profile;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.awt.Desktop;
import java.net.URI;

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
public class DesktopLauncher implements ApplicationRunner {
    private static final Logger log = LoggerFactory.getLogger(DesktopLauncher.class);

    private volatile int port = -1;

    /**
     * 端口从<b>实际启动的 Web 服务器</b>上取，不从配置里读。
     *
     * <p>桌面版默认让系统分配端口（{@code server.port=0}）：固定端口在「用户已经跑了一个
     * 别的服务占着 8080」时会直接启动失败，而那对双击启动的人来说是一句看不懂的报错。
     * 配置里写死多少，和实际监听在哪，是两件事。
     */
    @EventListener(ApplicationReadyEvent.class)
    public void captureActualPort(ApplicationReadyEvent event) {
        if (event.getApplicationContext() instanceof WebServerApplicationContext web
                && web.getWebServer() != null) {
            port = web.getWebServer().getPort();
        }
    }

    @Override
    public void run(ApplicationArguments args) {
        if (port <= 0) {
            log.warn("拿不到实际端口，跳过自动打开界面");
            return;
        }
        String url = "http://127.0.0.1:" + port + "/dashboard.html";
        log.info("桌面版已就绪：{}", url);
        openBrowser(url);
    }

    /**
     * 打不开浏览器<b>不能让启动失败</b>。
     *
     * <p>无头环境、沙箱、没有默认浏览器都会走到这里。这时后端其实是好的 ——
     * 把地址打进日志让用户自己复制，比抛异常把整个应用带崩强得多。
     */
    private void openBrowser(String url) {
        try {
            if (Desktop.isDesktopSupported() && Desktop.getDesktop().isSupported(Desktop.Action.BROWSE)) {
                Desktop.getDesktop().browse(URI.create(url));
                return;
            }
            log.info("这台机器不支持自动打开浏览器，请手动访问：{}", url);
        } catch (Exception e) {
            log.info("自动打开浏览器失败（不影响使用），请手动访问 {} —— {}", url, e.getMessage());
        }
    }
}
