package com.zhiqu;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
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
    /** HTML 里对 assets 下 js/css 的引用，连同它可能带的查询串一起捕获 —— 判据要看的正是「带没带」。 */
    private static final Pattern ASSET_REF =
            Pattern.compile("(?:src|href)=\"(assets/[^\"]*\\.(?:js|css)(?:\\?[^\"]*)?)\"");

    @Test
    void 全部页面与serviceWorker共用同一个缓存令牌() throws IOException {
        Map<String, String> byFile = collectAssetTokens();

        assertFalse(byFile.isEmpty(),
                "未在 " + STATIC_DIR.toAbsolutePath() + " 下匹配到任何 ?v= 引用；"
                        + "若资源引用形态变了，请同步更新本测试的正则，不要直接删除它");
        // 已知的三处覆盖边界，形态变化时一并处理：
        //   1. Files.list 不递归——子目录下的 HTML 不在覆盖内；
        //   2. 正则要求令牌紧跟引号——将来若出现 ?v=X&y=1 会把整串当成令牌；
        //   3. 只看 HTML 里的静态引用——katex 在任何页面里都没有 <script>/<link>，
        //      而是 zhiqu-api.js:1947 起按需动态注入，两条判据天然都管不到它。
        //      今天不是缺口（vendored + 版本固定在路径里 + 由 SW 预缓存），
        //      但它是第三种引用形态：哪天有人给动态注入的 URL 加令牌语义，这里不会响。

        TreeSet<String> distinct = new TreeSet<>(byFile.values());
        assertEquals(1, distinct.size(),
                "HTML 之间的缓存令牌发生漂移，改动不会送达全部页面：" + byFile);

        String htmlToken = distinct.first();
        assertEquals(htmlToken, serviceWorkerToken(),
                "service-worker.js 的 ZHIQU_CACHE 与页面资源令牌不一致，"
                        + "SW 缓存不会随资源一起失效");
    }

    /**
     * 每个 {@code assets/*.js|css} 引用都必须带 {@code ?v=} —— 上面那条判据看不见的另一半。
     *
     * <p><b>为什么上面那条抓不到：</b>{@link #collectAssetTokens()} 只匹配<b>已经带 {@code ?v=}</b>
     * 的引用，且文件里一个都没有时整个文件被 {@code if (!tokens.isEmpty())} 跳过。
     * 裸引用对它是隐形的 —— 它管的是「令牌互不相同」，不管「令牌根本没有」。
     *
     * <p><b>这不是假想场景。</b>本判据建立前，`zhiqu-ui.js` 在 13 个页面里只有 2 个带令牌
     * （admin.html、ai-assistant.html），`zhiqu-ui.css` 在 14 个页面里只有 1 个带
     * （ai-assistant.html），而上面那条判据一直是绿的。裸着的那 11 / 13 个页面，
     * 就是在它眼皮底下裸了很久的。
     *
     * <p>后果与令牌漂移完全一样，且同样不报错：{@code /assets/**} 没有任何 {@code Cache-Control}
     * （{@code WebMvcConfig} 只给 {@code /service-worker.js} 设了 {@code noCache()}），
     * 走浏览器启发式缓存，于是改了资源、用户继续拿旧的。
     *
     * <h3>范围只到 {@code static/*.html}，<b>不要</b>顺手扫 service-worker.js</h3>
     *
     * <p>{@code service-worker.js} 的 {@code CORE_ASSETS} 里有 5 条不带令牌的 {@code /assets/...}
     * 路径，那是<b>对的，不是漏网</b>：SW 缓存整体由 {@code ZHIQU_CACHE} 换名作废，
     * 取用又走 {@code caches.match(request, {ignoreSearch:true})}。给预缓存清单加令牌
     * 反而会让缓存键与实际请求对不上。判据要是扫到那里，会把这 5 行报成违规，
     * 而下一个人多半会照着「修」—— 把一份正确的东西改坏。
     */
    @Test
    void 每个资源引用都必须带缓存令牌() throws IOException {
        Map<String, List<String>> bare = new LinkedHashMap<>();
        int seen = 0;
        int pageCount;
        try (Stream<Path> files = Files.list(STATIC_DIR)) {
            List<Path> pages = files.filter(path -> path.getFileName().toString().endsWith(".html")).sorted().toList();
            pageCount = pages.size();
            for (Path page : pages) {
                Matcher matcher = ASSET_REF.matcher(Files.readString(page, StandardCharsets.UTF_8));
                while (matcher.find()) {
                    seen++;
                    String reference = matcher.group(1);
                    if (!reference.contains("?v=")) {
                        bare.computeIfAbsent(page.getFileName().toString(), k -> new ArrayList<>()).add(reference);
                    }
                }
            }
        }

        // 扫空即绿的防护，与上面那条判据的 assertFalse(byFile.isEmpty()) 同一用途。
        // bare 为空有两种成因：真的全都带令牌，和**正则一个都没匹配上**，而本判据会把两者一律判绿。
        // 能让它扫空的形态变化都不离谱：属性改用单引号、引用写成带前导斜杠的 /assets/…、
        // 或页面挪进子目录（边界 1）。
        // 这条防护对本判据尤其必要：它的存在意义就是「一个看不见问题的判据在报绿」，
        // 少了下界，它自己正好是那个形状。
        // 下界取页面数是安全的：每个页面至少引 zhiqu-ui.css 与 zhiqu-api.js 两处（今天实际 41 处）。
        assertTrue(seen >= pageCount,
                "只匹配到 " + seen + " 个 assets 引用（页面 " + pageCount + " 个）；引用形态可能变了，"
                        + "请同步更新 ASSET_REF，不要直接删除本判据");

        assertTrue(bare.isEmpty(),
                "以下页面的资源引用没有缓存令牌，改动不会送达这些页面的用户（浏览器启发式缓存，"
                        + "不报错、不可见）：" + bare);
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
