package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;

/**
 * 知识 Wiki 换页（第六十九轮）：鼠标在目录项上停一下、或按下去，就先把正文取回来 —— 桌面应用连的是远程库，
 * 第一次打开每一页都要在「正在加载知识页…」上等一次往返。预取的只在 30 秒内、同一个登录下用，失败就照常取。
 */
class WikiPrefetchTest {
    @Test
    @DisplayName("目录预取（node 里跑发布的 paintWikiDoc / paintWikiTree）：取回来就不再取、在路上就等它、失败照常取、过期和换登录不用、停 120ms 才取")
    void 目录预取() throws Exception {
        NodeRunner.run(Path.of("src/test/resources/js/wiki-prefetch-check.js"),
                Path.of("src/main/resources/static/assets/pages/knowledge-wiki.js"));
    }
}
