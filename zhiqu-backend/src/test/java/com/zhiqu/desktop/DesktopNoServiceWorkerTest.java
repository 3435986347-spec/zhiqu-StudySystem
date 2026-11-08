package com.zhiqu.desktop;

import com.zhiqu.NodeRunner;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;

/**
 * 页面在桌面应用里不装 Service Worker、在浏览器里照常装（第一百二十六轮）。跑的是发布的 zhiqu-api.js 里那一段。
 * 桌面里装上的话，服务器停了 / 断网时它拿缓存的页面顶上，WebKit 当成载入成功，外壳就不说「连不上」——
 * 用户在真窗口里停了验证站、按 ⌘R 照出来的。外壳那一侧（启动时清掉以前装上的）在 DesktopPageViewTest 的真 WKWebView 里验。
 */
class DesktopNoServiceWorkerTest {

    @Test
    @DisplayName("有外壳的桥就不注册 Service Worker；浏览器里照常注册（对照）")
    void 桌面里不装() throws Exception {
        NodeRunner.run(Path.of("src/test/resources/js/shell-cache-desktop-check.js"), NodeRunner.API_JS);
    }
}
