package com.zhiqu;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 缓存令牌一致性：全部 HTML 的 ?v=&lt;token&gt; 必须彼此相同，且等于 service-worker.js 的 ZHIQU_CACHE 后缀。
 *
 * <p>为什么需要这条测试：service worker 是 network-first + {@code caches.match(request, {ignoreSearch:true})}
 * 回退，所以 {@code ?v=} 真正的作用是让**浏览器 HTTP 缓存**失效，而 ZHIQU_CACHE 负责整体清理 SW 缓存。
 * 二者一旦漂移，改动只会送达被改过的那几个页面，其余页面的用户继续拿旧 bundle——不报错、不可见。
 *
 * <p>本测试建立时仓库正处于这种漂移态：13 个页面停留在旧令牌，只有 admin.html 的 zhiqu-api.js
 * 被单独升到了 -rag-lease1，于是那次修复只对 admin.html 的访问者生效。
 */
class StaticAssetCacheTokenTest {

    private static final Path STATIC_DIR = Path.of("src", "main", "resources", "static");
    private static final Pattern ASSET_TOKEN = Pattern.compile("\\?v=([^\"]+)\"");
    private static final Pattern CACHE_KEY = Pattern.compile("ZHIQU_CACHE\\s*=\\s*'zhiqu-shell-v([^']+)'");

    @Test
    void 全部页面与serviceWorker共用同一个缓存令牌() throws IOException {
        Map<String, String> byFile = collectAssetTokens();

        assertFalse(byFile.isEmpty(),
                "未在 " + STATIC_DIR.toAbsolutePath() + " 下匹配到任何 ?v= 引用；"
                        + "若资源引用形态变了，请同步更新本测试的正则，不要直接删除它");
        // 已知的两处覆盖边界，形态变化时一并处理：
        //   1. Files.list 不递归——子目录下的 HTML 不在覆盖内；
        //   2. 正则要求令牌紧跟引号——将来若出现 ?v=X&y=1 会把整串当成令牌。

        TreeSet<String> distinct = new TreeSet<>(byFile.values());
        assertEquals(1, distinct.size(),
                "HTML 之间的缓存令牌发生漂移，改动不会送达全部页面：" + byFile);

        String htmlToken = distinct.first();
        assertEquals(htmlToken, serviceWorkerToken(),
                "service-worker.js 的 ZHIQU_CACHE 与页面资源令牌不一致，"
                        + "SW 缓存不会随资源一起失效");
    }

    /** 返回「文件名 -> 该文件内出现的令牌集合（去重后拼接）」，值不唯一时便于定位是哪个文件漂了 */
    private Map<String, String> collectAssetTokens() throws IOException {
        Map<String, String> byFile = new LinkedHashMap<>();
        try (Stream<Path> files = Files.list(STATIC_DIR)) {
            List<Path> pages = files.filter(path -> path.getFileName().toString().endsWith(".html")).sorted().toList();
            for (Path page : pages) {
                TreeSet<String> tokens = new TreeSet<>();
                Matcher matcher = ASSET_TOKEN.matcher(Files.readString(page, StandardCharsets.UTF_8));
                while (matcher.find()) {
                    tokens.add(matcher.group(1));
                }
                if (!tokens.isEmpty()) {
                    byFile.put(page.getFileName().toString(), String.join(" + ", tokens));
                }
            }
        }
        return byFile;
    }

    private String serviceWorkerToken() throws IOException {
        Path worker = STATIC_DIR.resolve("service-worker.js");
        Matcher matcher = CACHE_KEY.matcher(Files.readString(worker, StandardCharsets.UTF_8));
        assertTrue(matcher.find(), "service-worker.js 中未找到 ZHIQU_CACHE = 'zhiqu-shell-v...' 声明");
        return matcher.group(1);
    }
}
