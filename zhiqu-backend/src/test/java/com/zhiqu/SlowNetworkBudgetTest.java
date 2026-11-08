package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.GZIPOutputStream;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 第一百二十轮：线上服务器的公网带宽只有约 1.5 Mbps（用户先不升级），打开网站像卡死了。
 * 一处在 {@code WebMvcConfig}（静态文件能被浏览器存着，见 {@code NetworkCompressionIntegrationTest}），
 * 这里管第一次打开时 Service Worker 抢走的那部分：等页面加载完再注册，预取的只有普通用户每天要开的。
 */
class SlowNetworkBudgetTest {

    private static final Path STATIC = Path.of("src/main/resources/static");
    /** 预取的总量（gzip 后）。减量那一次是 502KB → 166KB；页面长大了要加就改这里，并说为什么 */
    private static final int PRECACHE_GZIP_BUDGET = 200 * 1024;

    static List<String> coreAssets() throws Exception {
        String worker = Files.readString(STATIC.resolve("service-worker.js")).replaceAll("(?m)//.*$", "");
        Matcher list = Pattern.compile("CORE_ASSETS\\s*=\\s*\\[([\\s\\S]*?)\\]").matcher(worker);
        assertTrue(list.find(), "service-worker.js 里找不到 CORE_ASSETS");
        List<String> out = new ArrayList<>();
        Matcher item = Pattern.compile("'([^']+)'").matcher(list.group(1));
        while (item.find()) out.add(item.group(1));
        return out;
    }

    private static int gzipped(byte[] bytes) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (GZIPOutputStream gz = new GZIPOutputStream(out)) {
            gz.write(bytes);
        }
        return out.size();
    }

    @Test
    @DisplayName("Service Worker 等页面加载完、再过一会儿才注册（node 跑发布的 maintainShellCache）")
    void 页面先用带宽() throws Exception {
        NodeRunner.run(Path.of("src/test/resources/js/shell-cache-check.js"), NodeRunner.API_JS);
    }

    @Test
    @DisplayName("预取的只有普通用户每天要开的：不含后台页、KaTeX 和它的字体；gzip 后不超过预算；每一项都真的存在")
    void 预取的量() throws Exception {
        List<String> core = coreAssets();
        assertTrue(core.size() >= 10, "CORE_ASSETS 只解析出 " + core + "：判据在空转");
        String worker = Files.readString(STATIC.resolve("service-worker.js")).replaceAll("(?m)//.*$", "");
        assertFalse(worker.contains("FONT_ASSETS"), "又在预取字体了");
        int total = 0;
        for (String url : core) {
            assertFalse(url.contains("admin"), url + "：后台页普通用户不该下载");
            assertFalse(url.contains("katex"), url + "：KaTeX 只有带公式的 Wiki 页用，用到时 fetch 处理器会缓存");
            Path file = STATIC.resolve(url.equals("/") ? "index.html" : url.substring(1));
            assertTrue(Files.isRegularFile(file), url + " 不存在：addAll 会失败，整个 Service Worker 装不上");
            total += gzipped(Files.readAllBytes(file));
        }
        assertTrue(total <= PRECACHE_GZIP_BUDGET, "预取 gzip 后 " + total / 1024 + "KB，超过 " + PRECACHE_GZIP_BUDGET / 1024
                + "KB：线上 1.5 Mbps，每个新访客、每次换令牌都要整个下一遍");
    }
}
