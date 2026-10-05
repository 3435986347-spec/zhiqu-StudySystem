package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 方案第 4 步：{@code zhiqu-api.js} 一页一页拆成原生 ES 模块（第三十轮设置弹窗，第三十一轮起后台四页 → {@code assets/pages/}）。
 *
 * <p>拆出去的模块和壳之间只有两根线，两根断了都不报错，只在用户打开那一页时才炸：
 * <ul>
 *   <li>壳的 {@code PAGE_MODULES} 说「这一页去哪个文件找」—— 拼错一个、模块里少导出一个，页面一片空白（壳调的是 undefined）；</li>
 *   <li>模块从 {@code zqShared} 拿壳的东西 —— 壳没给的、或者模块用了却忘了解构出来的，打开那一页时才是 ReferenceError。</li>
 * </ul>
 * 第一根由 node 真的 import 每个模块来核对；第二根按名字扫（模块里的 {@code sh.xxx}、{@code ({ … } = sh)} 解构、以及壳的助手名被直接调用的地方）。
 */
class PageModulesTest {

    private static final Path STATIC = Path.of("src/main/resources/static");
    private static final Path ASSETS = STATIC.resolve("assets");

    private static String read(Path p) throws IOException {
        return Files.readString(p, StandardCharsets.UTF_8);
    }

    private static String shell() throws IOException {
        return SourceText.stripComments(read(NodeRunner.API_JS));
    }

    private static String fn(String code, String signature) {
        int a = code.indexOf(signature);
        assertTrue(a >= 0, "找不到 " + signature);
        int b = code.indexOf("\n  }\n", a);
        assertTrue(b > a, signature + " 没有结尾");
        return code.substring(a, b);
    }

    /** 壳的 PAGE_MODULES：页面文件名 → assets 下的模块。 */
    private static Map<String, String> pageModules() throws IOException {
        String shell = shell();
        int a = shell.indexOf("var PAGE_MODULES = {");
        assertTrue(a >= 0, "壳里找不到 var PAGE_MODULES = {");
        String literal = shell.substring(a, shell.indexOf("};", a));
        Map<String, String> out = new LinkedHashMap<>();
        Matcher m = Pattern.compile("'([a-z0-9-]+\\.html)':\\s*'([^']+)'").matcher(literal);
        while (m.find()) out.put(m.group(1), m.group(2));
        return out;
    }

    /** assets 下壳以外的模块（设置弹窗、页面模块）。 */
    private static List<Path> modules() throws IOException {
        try (Stream<Path> walk = Files.walk(ASSETS)) {
            return walk.filter(p -> p.toString().endsWith(".js"))
                    .filter(p -> !p.toString().contains("/vendor/"))
                    .filter(p -> !Set.of("zhiqu-api.js", "zhiqu-ui.js").contains(p.getFileName().toString()))
                    .sorted().toList();
        }
    }

    @Test
    @DisplayName("PAGE_MODULES 的每一项都接得上：文件在、导出了 boots、boots 里有这一页（node 真的 import）")
    void 页面模块表接得上() throws Exception {
        Map<String, String> table = pageModules();
        assertTrue(table.size() >= 4, "PAGE_MODULES 里只解析出 " + table + " —— 扫空了？");
        List<String> pairs = new ArrayList<>();
        table.forEach((page, rel) -> pairs.add(page + "=" + rel));
        NodeRunner.run(Path.of("src/test/resources/js/page-modules-check.js"), ASSETS, pairs.toArray(new String[0]));
    }

    @Test
    @DisplayName("每个应用页面都由 PAGE_MODULES 里的一个模块启动（第三十七轮起壳里不再有 boots 表）—— 漏了的那一页打开就是一片空白")
    void 每个页面都有人启动() throws IOException {
        String shell = shell();
        assertFalse(shell.contains("var boots = {"), "壳里又有了一张 boots 表 —— 页面的代码都该在 assets/pages/ 的模块里（方案第 4 步）");
        Set<String> modules = pageModules().keySet();
        List<String> orphan = new ArrayList<>();
        int pages = 0;
        try (Stream<Path> files = Files.list(STATIC)) {
            for (Path p : files.filter(x -> x.toString().endsWith(".html")).sorted().toList()) {
                String name = p.getFileName().toString();
                // 落地页自己启动；个人中心 / 成就页是第三十轮留下的跳转页（route() 一开头就跳走）
                if (Set.of("index.html", "profile.html", "achievement.html").contains(name)) continue;
                pages++;
                if (!modules.contains(name)) orphan.add(name);
            }
        }
        assertTrue(pages >= 11, "只扫到 " + pages + " 个应用页面");
        assertEquals(List.of(), orphan, "这些页面没有人启动 —— 打开就是一片空白，一个字都不报");
    }

    /** 「今天」要跟着业务日期走的页面：页面开着过了零点要重新取。原来是壳里的 DAY_RELOAD 表，第三十五轮看板挪走之后删了，由页面模块导出 dayReload。 */
    static final Set<String> DAY_PAGES = Set.of("dashboard.html", "routines.html");

    @Test
    @DisplayName("页面开着跨过业务日期的零点：看板、例行计划的模块导出 dayReload（node 真 import），壳接到 watchBusinessDay 上；壳里不再有第二套（DAY_RELOAD）")
    void 零点重新取数据() throws Exception {
        String shell = shell();
        assertFalse(shell.contains("DAY_RELOAD"), "壳里又有了 DAY_RELOAD —— 零点重新取数据只该有一套（页面模块导出的 dayReload）");
        String route = fn(shell, "function route() {");
        int load = route.indexOf("var pageModule = await loadModule(PAGE_MODULES[page]);");
        int watch = route.indexOf("watchBusinessDay(pageModule.dayReload[page]);");
        assertTrue(load >= 0 && watch > load, "页面模块的 dayReload 没有接到 watchBusinessDay 上 —— 页面开着过了零点，「今天」还是昨天");
        Map<String, String> table = pageModules();
        List<String> pairs = new ArrayList<>();
        for (String page : DAY_PAGES) {
            assertTrue(table.containsKey(page), page + " 不在 PAGE_MODULES 里");
            pairs.add(page + "=" + table.get(page) + "+dayReload");
        }
        NodeRunner.run(Path.of("src/test/resources/js/page-modules-check.js"), ASSETS, pairs.toArray(new String[0]));
    }

    @Test
    @DisplayName("模块只用 zqShared 给了的东西；壳的助手在模块里被直接调用时，模块要么解构了它、要么自己定义了它（否则打开那一页才 ReferenceError）")
    void 模块只用壳给的东西() throws IOException {
        String shell = shell();
        int a = shell.indexOf("var zqShared = {");
        assertTrue(a >= 0, "壳里找不到 var zqShared = {");
        String literal = shell.substring(a, shell.indexOf("};", a));
        Set<String> given = new TreeSet<>();
        Matcher k = Pattern.compile("([A-Za-z_$][A-Za-z0-9_$]*):\\s*[A-Za-z_$]").matcher(literal);
        while (k.find()) given.add(k.group(1));
        assertTrue(given.size() >= 20, "zqShared 里只解析出 " + given);

        List<String> problems = new ArrayList<>();
        int seen = 0;
        List<Path> files = modules();
        assertTrue(files.size() >= 2, "assets 下只扫到 " + files + " 这几个模块");
        for (Path f : files) {
            String js = SourceText.stripComments(read(f));
            String name = ASSETS.relativize(f).toString();
            Set<String> bound = new TreeSet<>();
            Matcher d = Pattern.compile("\\(\\{([^}]*)\\}\\s*=\\s*sh\\)").matcher(js);
            while (d.find()) for (String part : d.group(1).split(",")) if (!part.isBlank()) bound.add(part.trim());
            Set<String> used = new TreeSet<>(bound);
            Matcher u = Pattern.compile("\\bsh\\.([A-Za-z_$][A-Za-z0-9_$]*)").matcher(js);
            while (u.find()) used.add(u.group(1));
            seen += used.size();
            for (String x : used) if (!given.contains(x)) problems.add(name + " 用了 zqShared 里没有的 " + x);

            // 直接调用壳的助手名而没有解构出来、也没有自己定义：模块作用域里没有它
            for (String helper : given) {
                Matcher call = Pattern.compile("(?<![\\w.$])" + Pattern.quote(helper) + "\\s*\\(").matcher(js);
                if (!call.find()) continue;
                // 自己定义的：function x / var x = …（设置弹窗的 var $ = (s) => root.querySelector(s)）。
                // 模块顶上那行只声明不赋值的 let api, esc, …; 不算 —— 声明了却没解构，照样是 undefined
                String q = Pattern.quote(helper);
                boolean defined = Pattern.compile("function\\s+" + q + "(?![\\w$])|(?:var|let|const)\\s+" + q + "\\s*=").matcher(js).find();
                if (!bound.contains(helper) && !defined) problems.add(name + " 直接调用了 " + helper + "(…)，却没有从 zqShared 解构出来、也没有自己定义");
            }
        }
        assertTrue(seen >= 20, "模块里一共只认出 " + seen + " 样从壳拿的东西 —— 扫空了？");
        assertEquals(List.of(), problems, "模块和壳之间的线断了：");
    }

    @Test
    @DisplayName("模块被 import 时没有副作用：顶层只有声明（function / let / var / const / export）—— 定时器、监听、读 DOM 都在 boot 里开始")
    void 模块顶层只有声明() throws IOException {
        // 第三十七轮：AI 助手原来在壳顶层开了一个每秒一次的定时器（每一页都在跑）。挪进模块后它会在 import 时就跑 ——
        // 测试在 node 里 import 模块（那里没有 document），而且模块「只在需要时才加载」的前提就是加载本身不做事。
        // 扰动时发现它能悄悄混过去：定时器 1 秒后才第一次触发，node 判据在那之前就跑完退出了。所以这里按源码钉。
        List<String> bad = new ArrayList<>();
        int lines = 0;
        for (Path f : modules()) {
            String js = SourceText.stripComments(read(f));
            for (String line : js.split("\n")) {
                lines++;
                if (line.matches("^(?!function |async function |let |var |const |export |import |\\}|\\)|\\]|\\s|$)\\S.*")) {
                    bad.add(ASSETS.relativize(f) + "：" + line.substring(0, Math.min(100, line.length())));
                }
            }
        }
        assertTrue(lines >= 3000, "模块一共只扫到 " + lines + " 行 —— 扫空了？");
        assertEquals(List.of(), bad, "模块顶层有会在 import 时就执行的语句（把它挪进 boot 里）");
    }

    @Test
    @DisplayName("后台页的门在加载模块之前：普通用户直达后台页时，后台的模块连下载都不下载")
    void 后台页的门在加载模块之前() throws IOException {
        String route = fn(shell(), "function route() {");
        int gate = route.indexOf("window.ZQUI.isAdminPage(page) && !currentUserIsAdmin()");
        // 第一处（不管有没有 await）：在门之前「顺手预取」一下，同样是让普通用户下载了后台的代码
        int load = route.indexOf("loadModule(PAGE_MODULES[page])");
        assertTrue(gate >= 0 && load > gate, "后台页的门要在 loadModule 之前");
        String worker = read(STATIC.resolve("service-worker.js")).replaceAll("(?m)//.*$", "");
        assertFalse(worker.contains("pages/"), "离线缓存预先下载了页面模块 —— 后台那一个普通用户不该下载");
        try (Stream<Path> files = Files.list(STATIC)) {
            for (Path p : files.filter(x -> x.toString().endsWith(".html")).toList()) {
                assertFalse(Pattern.compile("<script[^>]*assets/pages/").matcher(read(p)).find(),
                        p.getFileName() + " 直接加载了页面模块 —— 应当由壳按页面 import");
            }
        }
    }

    @Test
    @DisplayName("壳加载模块：地址带上壳的 ?v=、同一个只加载一次、加载不上时说人话、失败的不缓存（node 用真的 import() 跑发布的 loadModule）")
    void 模块加载() throws Exception {
        NodeRunner.run(Path.of("src/test/resources/js/module-load-check.js"), NodeRunner.API_JS);
    }
}
