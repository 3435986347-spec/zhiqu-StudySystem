package com.zhiqu.desktop;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Locale;

/**
 * 让 macOS 认为这个应用「启动完成了」。
 *
 * <h2>它修的是什么</h2>
 *
 * <p>2026-09-21：打包好的 {@code .app} 双击之后 <b>Dock 图标无限弹跳</b>，页面不弹。
 * 后端其实一切正常 —— Tomcat 起来了、数据库连上了、{@code /index.html} 返回 200。
 *
 * <p>用 {@code lsappinfo} 看那个进程，关键一项是 <b>{@code !cgsConnection}</b>：
 * 它没有和 CoreGraphics 窗口服务器建立连接。macOS 对一个「前台类型」的应用
 * （{@code ApplicationType=Foreground}，jpackage 默认就是这种）会一直弹跳图标，
 * 直到它连上窗口服务器为止 —— 而一个纯后端的 JVM 永远不会连。
 *
 * <p>Spring Boot 会默认设 {@code java.awt.headless=true}，这让情况板上钉钉：
 * AWT 根本不会初始化，连接也就无从谈起。
 *
 * <h2>为什么是「碰一下 Toolkit」而不是别的</h2>
 *
 * <p>在 macOS 上初始化 AWT 工具包会创建 {@code NSApplication} 并连上窗口服务器，
 * 弹跳随即停止。图标留在 Dock 里 —— 这是想要的：用户可以右键退出。
 *
 * <p>另一条路是在 {@code Info.plist} 里写 {@code LSUIElement=true}，
 * 把它变成没有 Dock 图标的后台程序。弹跳同样会停，但用户就<b>没有办法退出它了</b>
 * （只能去活动监视器），所以没选这条。
 *
 * <p>失败一律吞掉：Dock 图标是观感问题，不值得让一个能正常服务的后端启动失败。
 * 非 macOS 上直接跳过 —— Windows 与 Linux 没有这个行为。
 */
final class DockPresence {

    private static final Logger log = LoggerFactory.getLogger(DockPresence.class);

    /** 当前平台需不需要这一步。<b>纯函数</b>，判据直接调它。 */
    static boolean neededOn(String osName) {
        return osName != null && osName.toLowerCase(Locale.ROOT).contains("mac");
    }

    /**
     * 连上窗口服务器，让 Dock 停止弹跳。
     *
     * @return 真的做了这一步返回 true（非 macOS、或 headless 被强制打开时返回 false）
     */
    static boolean settle(String osName) {
        if (!neededOn(osName)) {
            return false;
        }
        if (Boolean.getBoolean("java.awt.headless")) {
            log.debug("java.awt.headless=true，跳过 Dock 注册；图标可能会持续弹跳");
            return false;
        }
        try {
            java.awt.Toolkit.getDefaultToolkit();
            return true;
        } catch (Throwable t) {
            // Throwable 而不是 Exception：无头环境下这里抛的是 HeadlessException 之外的
            // Error（如 UnsatisfiedLinkError / NoClassDefFoundError），漏掉就会把启动带崩。
            log.debug("连接窗口服务器失败，Dock 图标可能会持续弹跳：{}", t.toString());
            return false;
        }
    }

    private DockPresence() {
    }
}
