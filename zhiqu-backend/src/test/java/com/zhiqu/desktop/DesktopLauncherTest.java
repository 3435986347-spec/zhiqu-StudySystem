package com.zhiqu.desktop;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.boot.web.context.WebServerApplicationContext;
import org.springframework.boot.web.server.WebServer;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 钉住「双击之后界面真的会被打开」。
 *
 * <p>由来是 2026-09-21 的一次实地故障：打包好的 {@code .app} 双击后 Dock 图标一直跳、
 * 页面不弹。后端其实<b>完全正常</b> —— Tomcat 绑在 127.0.0.1、Hikari 连上了 MySQL、
 * Redis 也通、{@code /index.html} 返回 200。坏的只有这个类，而它当时一条判据都没有。
 *
 * <p>两个各自独立的原因：
 * <ol>
 *   <li>打开动作写在 {@code ApplicationRunner.run()} 里，端口却由一个
 *       {@code ApplicationReadyEvent} 监听器填。Spring Boot 先 {@code callRunners()}
 *       再发 ready 事件，所以 {@code run()} 看到的端口永远是 -1。</li>
 *   <li>就算顺序对了也打不开：用的是 {@code java.awt.Desktop}，而 Spring Boot 默认
 *       {@code java.awt.headless=true}，{@code isDesktopSupported()} 必然 false。</li>
 * </ol>
 *
 * <p>之前那次「完整验证」查了 HTTP 通不通、绑的是不是回环、迁移跑没跑完 —— 全过，
 * 因为后端确实是好的。唯独没查这个类唯一的职责。
 */
class DesktopLauncherTest {

    /** 记录被要求打开了什么，不真的开浏览器。 */
    private static final class RecordingOpener implements BrowserOpener {
        private final List<String> opened = new ArrayList<>();
        private boolean succeed = true;

        @Override
        public boolean open(String url) {
            opened.add(url);
            return succeed;
        }
    }

    // ── 核心行为：ready 之后必须真的去开，而且带着真实端口 ──────────────

    @Test
    @DisplayName("应用就绪后，用实际监听的端口去打开浏览器")
    void 就绪后带着实际端口打开() {
        RecordingOpener opener = new RecordingOpener();
        DesktopLauncher launcher = new DesktopLauncher(opener);

        launcher.openWhenReady(readyEventOnPort(60795));

        assertEquals(List.of("http://127.0.0.1:60795" + DesktopLauncher.LANDING_PAGE),
                opener.opened,
                "就绪之后必须真的调用一次打开，且地址要用实际端口");
        assertEquals("http://127.0.0.1:60795" + DesktopLauncher.LANDING_PAGE, launcher.openedUrl());
    }

    @Test
    @DisplayName("端口取不到时不打开，也不抛异常")
    void 拿不到端口就安静跳过() {
        RecordingOpener opener = new RecordingOpener();
        DesktopLauncher launcher = new DesktopLauncher(opener);

        ApplicationReadyEvent event = mock(ApplicationReadyEvent.class);
        when(event.getApplicationContext()).thenReturn(mock(ConfigurableApplicationContext.class));

        launcher.openWhenReady(event);

        assertTrue(opener.opened.isEmpty(), "端口未知时不该去开一个错的地址");
        assertNull(launcher.openedUrl());
    }

    @Test
    @DisplayName("浏览器打不开时应用照常可用 —— 不抛异常，地址仍记录下来")
    void 打不开浏览器不影响启动() {
        RecordingOpener opener = new RecordingOpener();
        opener.succeed = false;
        DesktopLauncher launcher = new DesktopLauncher(opener);

        launcher.openWhenReady(readyEventOnPort(12345));

        assertEquals(1, opener.opened.size(), "失败也得先试过");
        assertNotNull(launcher.openedUrl(), "打不开时更要把地址留下来给用户手动访问");
    }

    // ── 原生外壳接手时不能再弹浏览器 ──────────────────────────────────

    @Test
    @DisplayName("设了端口文件属性 → 把端口写出去，且不开浏览器")
    void 交给外壳时不开浏览器() throws IOException {
        Path portFile = Files.createTempDirectory("zhiqu-port-test").resolve("port");
        RecordingOpener opener = new RecordingOpener();
        DesktopLauncher launcher = new DesktopLauncher(opener);

        withPortFileProperty(portFile.toString(),
                () -> launcher.openWhenReady(readyEventOnPort(63826)));

        assertTrue(opener.opened.isEmpty(),
                "外壳已经负责显示界面了，再弹一个浏览器标签页就是两个界面");
        assertTrue(Files.exists(portFile), "端口文件没写出来，外壳会一直等到超时");
        assertEquals("63826", Files.readString(portFile).trim());
    }

    @Test
    @DisplayName("没设端口文件属性 → 回退到开浏览器（java -jar 直接跑的场景）")
    void 没有外壳时仍然开浏览器() {
        RecordingOpener opener = new RecordingOpener();
        DesktopLauncher launcher = new DesktopLauncher(opener);

        // 显式确保属性不存在，不依赖测试执行顺序
        String previous = System.clearProperty(DesktopLauncher.PORT_FILE_PROPERTY);
        try {
            launcher.openWhenReady(readyEventOnPort(1234));
        } finally {
            if (previous != null) {
                System.setProperty(DesktopLauncher.PORT_FILE_PROPERTY, previous);
            }
        }
        assertEquals(1, opener.opened.size(), "没有外壳接手时必须仍然把界面打开");
    }

    @Test
    @DisplayName("端口文件写不进去也不能让启动崩掉")
    void 端口文件写失败不抛异常() {
        RecordingOpener opener = new RecordingOpener();
        DesktopLauncher launcher = new DesktopLauncher(opener);

        // 指向一个不存在的目录 —— createTempFile 会失败
        withPortFileProperty("/nonexistent-dir-zhiqu/port",
                () -> launcher.openWhenReady(readyEventOnPort(4321)));

        assertNotNull(launcher.openedUrl(), "写文件失败了，地址仍要留在日志和这里给用户");
    }

    @Test
    @DisplayName("端口文件是原子落地的 —— 外壳不能读到半个端口号")
    void 端口文件原子写入() throws IOException {
        String source = Files.readString(
                Path.of("src", "main", "java", "com", "zhiqu", "desktop", "DesktopLauncher.java"),
                StandardCharsets.UTF_8);
        assertTrue(source.contains("handOffToShell"), "扫到的不是这个类 —— 空扫会假绿");
        assertTrue(source.contains("ATOMIC_MOVE"),
                "端口文件必须先写临时文件再原子改名。直接写的话外壳可能读到 \"63\" "
                        + "而不是 \"63826\"，然后连到别人的端口上去。");
        assertTrue(source.contains("createTempFile"),
                "没有临时文件，原子改名就无从谈起");
    }

    // ── 顺序：这个 bug 的根因不能再回来 ────────────────────────────────

    @Test
    @DisplayName("不得再用 ApplicationRunner —— 它比 ApplicationReadyEvent 先跑，端口还没有")
    void 不得依赖ApplicationRunner() throws IOException {
        Path source = Path.of("src", "main", "java", "com", "zhiqu", "desktop", "DesktopLauncher.java");
        String text = stripComments(Files.readString(source, StandardCharsets.UTF_8));
        assertTrue(text.contains("openWhenReady"), "扫到的不是这个类 —— 空扫会让下面的断言假绿");

        assertFalse(text.contains("implements ApplicationRunner"),
                "DesktopLauncher 又实现了 ApplicationRunner。Spring Boot 先 callRunners() "
                        + "再发 ApplicationReadyEvent，所以 runner 里读不到端口 —— "
                        + "这正是 2026-09-21 那次「双击没反应」的根因。");
        assertFalse(text.contains("ApplicationArguments"),
                "ApplicationArguments 只在 runner 回调里出现，说明 runner 又回来了");
    }

    @Test
    @DisplayName("不得再用 java.awt.Desktop —— Spring Boot 默认 headless，那条分支永远走不到")
    void 不得依赖AWT() throws IOException {
        Path dir = Path.of("src", "main", "java", "com", "zhiqu", "desktop");
        List<Path> sources;
        try (var walk = Files.walk(dir)) {
            sources = walk.filter(p -> p.toString().endsWith(".java")).toList();
        }
        assertTrue(sources.size() >= 3, "desktop 包下只扫到 " + sources.size() + " 个文件 —— 扫空了");

        List<String> offenders = new ArrayList<>();
        for (Path source : sources) {
            String text = stripComments(Files.readString(source, StandardCharsets.UTF_8));
            if (text.contains("java.awt.Desktop") || text.contains("Desktop.getDesktop")) {
                offenders.add(source.getFileName().toString());
            }
        }
        assertTrue(offenders.isEmpty(),
                "这些文件又用上了 java.awt.Desktop：" + offenders
                        + "。SpringApplication 默认设 java.awt.headless=true，"
                        + "isDesktopSupported() 必然 false，那段代码是死的。");
    }

    // ── 各平台的打开命令 ──────────────────────────────────────────────

    @Test
    @DisplayName("三个平台各给出能用的打开命令，未知平台给空")
    void 平台命令() {
        assertEquals(List.of("/usr/bin/open", "http://x"),
                BrowserOpener.Platform.commandFor("Mac OS X", "http://x"));
        assertEquals(List.of("rundll32", "url.dll,FileProtocolHandler", "http://x"),
                BrowserOpener.Platform.commandFor("Windows 11", "http://x"));
        assertEquals(List.of("xdg-open", "http://x"),
                BrowserOpener.Platform.commandFor("Linux", "http://x"));
        assertTrue(BrowserOpener.Platform.commandFor("Haiku", "http://x").isEmpty());
        assertTrue(BrowserOpener.Platform.commandFor("", "http://x").isEmpty());
    }

    @Test
    @DisplayName("Windows 不走 shell —— URL 里的 & 不能被当成命令分隔符")
    void windows不经过shell() {
        List<String> command = BrowserOpener.Platform.commandFor("Windows 11", "http://x?a=1&b=2");
        assertFalse(command.contains("cmd"), "经过 cmd /c start 的话 & 会截断命令：" + command);
        assertEquals("http://x?a=1&b=2", command.get(command.size() - 1),
                "URL 必须作为一个独立参数原样传下去");
    }

    @Test
    @DisplayName("打不开时返回 false 而不是抛异常")
    void 打开失败不抛异常() {
        // 未知平台 → 没有命令 → false
        assertFalse(new BrowserOpener.Platform("Haiku").open("http://127.0.0.1:1/x"));
    }

    // ── helpers ───────────────────────────────────────────────────────

    /**
     * {@code ApplicationReadyEvent.getApplicationContext()} 的静态类型是
     * {@code ConfigurableApplicationContext}，而端口要从 {@code WebServerApplicationContext}
     * 上取 —— 生产代码里那个 {@code instanceof} 正是在做这次收窄。假件必须同时是两者。
     */
    private interface WebContext extends ConfigurableApplicationContext, WebServerApplicationContext {
    }

    /** 在设了端口文件属性的情况下跑一段代码，跑完一定还原 —— 属性是全局的。 */
    private static void withPortFileProperty(String value, Runnable body) {
        String previous = System.getProperty(DesktopLauncher.PORT_FILE_PROPERTY);
        System.setProperty(DesktopLauncher.PORT_FILE_PROPERTY, value);
        try {
            body.run();
        } finally {
            if (previous == null) {
                System.clearProperty(DesktopLauncher.PORT_FILE_PROPERTY);
            } else {
                System.setProperty(DesktopLauncher.PORT_FILE_PROPERTY, previous);
            }
        }
    }

    private static ApplicationReadyEvent readyEventOnPort(int port) {
        WebServer webServer = mock(WebServer.class);
        when(webServer.getPort()).thenReturn(port);
        WebContext context = mock(WebContext.class);
        when(context.getWebServer()).thenReturn(webServer);
        ApplicationReadyEvent event = mock(ApplicationReadyEvent.class);
        when(event.getApplicationContext()).thenReturn(context);
        return event;
    }

    /** 先行注释、再块注释 —— 顺序反了会被 {@code //} 里的 {@code /*} 带偏（见 SourceText）。 */
    private static String stripComments(String source) {
        return source.replaceAll("(?m)//.*$", "")
                .replaceAll("(?s)/\\*.*?\\*/", "");
    }
}
