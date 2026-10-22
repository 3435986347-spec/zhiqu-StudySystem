package com.zhiqu.desktop;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.util.List;
import java.util.Locale;

/**
 * 「把这个地址在系统浏览器里打开」—— 抽成接口<b>只是为了能被判据看见</b>。
 *
 * <p>2026-09-21 的故障里，浏览器一次都没被打开过，而这件事在当时的判据里是不可观测的：
 * 打开动作藏在一个 {@code private void} 里，没有任何返回值，失败还被有意吞掉。
 * 于是「桌面版能不能把界面打开」只能靠人双击一次来验证 —— 而那一次验证只查了
 * HTTP 通不通，没查窗口有没有弹出来。
 */
public interface BrowserOpener {

    /**
     * 打开地址。<b>实现不得抛异常</b> —— 打不开浏览器绝不能把应用带崩。
     *
     * @return 真的打开了返回 true
     */
    boolean open(String url);

    /**
     * 各平台各自的「打开」命令。
     *
     * <p><b>不用 {@code java.awt.Desktop}</b>：Spring Boot 默认会设
     * {@code java.awt.headless=true}（{@code SpringApplication} 的默认行为），
     * 于是 {@code Desktop.isDesktopSupported()} 必然返回 false，那条分支永远走不到。
     * 这正是 2026-09-21 那次「双击了没反应」的第二个原因 —— 第一个是
     * {@code ApplicationRunner} 比 {@code ApplicationReadyEvent} 先跑，端口还没拿到。
     *
     * <p>调 {@code /usr/bin/open} / {@code rundll32} / {@code xdg-open} 则跟 AWT 无关，
     * 也就跟 headless 无关。
     */
    class Platform implements BrowserOpener {

        private static final Logger log = LoggerFactory.getLogger(Platform.class);

        private final String osName;

        public Platform() {
            this(System.getProperty("os.name", ""));
        }

        Platform(String osName) {
            this.osName = osName == null ? "" : osName;
        }

        @Override
        public boolean open(String url) {
            List<String> command = commandFor(osName, url);
            if (command.isEmpty()) {
                log.info("这个平台（{}）不知道怎么自动打开浏览器，请手动访问：{}", osName, url);
                return false;
            }
            try {
                new ProcessBuilder(command).start();
                return true;
            } catch (IOException e) {
                log.info("自动打开浏览器失败（不影响使用），请手动访问 {} —— {}", url, e.getMessage());
                return false;
            }
        }

        /**
         * 平台 → 命令。<b>纯函数</b>，判据直接调它，不用真的开浏览器。
         *
         * <p>Windows 走 {@code rundll32 url.dll,FileProtocolHandler} 而不是
         * {@code cmd /c start}：后者要经过 shell，URL 里的 {@code &} 会被当成命令分隔符。
         * 这里的地址目前没有查询参数，但一个「打开任意 URL」的工具不该埋这种雷。
         */
        static List<String> commandFor(String osName, String url) {
            String os = osName.toLowerCase(Locale.ROOT);
            if (os.contains("mac")) {
                return List.of("/usr/bin/open", url);
            }
            if (os.contains("win")) {
                return List.of("rundll32", "url.dll,FileProtocolHandler", url);
            }
            if (os.contains("nux") || os.contains("nix") || os.contains("bsd")) {
                return List.of("xdg-open", url);
            }
            return List.of();
        }
    }
}
