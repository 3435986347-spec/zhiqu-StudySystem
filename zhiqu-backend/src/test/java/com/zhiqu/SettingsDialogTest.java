package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 第三十轮（用户 2026-10-04 定的）：侧栏只放干活的地方，设置、成就、专注统计、界面风格、后台、退出都在左下角头像点开的菜单里；
 * 设置和成就是 Claude 那样的弹窗，跟着地址走（{@code #settings/<栏>}、{@code #achievements}）。
 *
 * <p>这也是方案第 4 步（前端拆模块）的第一块：设置和成就的代码从 zhiqu-api.js 挪进了第一个 ES 模块 {@code assets/settings.js}，
 * 第一次打开时才 import，用到的壳里的东西都经 {@code zqShared} 给。这里钉的是那几处「接线断了一个字都不报」的地方：
 * 模块用了壳没给的东西（打开弹窗时才炸）、模块没带上缓存令牌（发版之后旧模块配新壳）、旧地址和命令行打印的链接打不开对的那一栏。
 * 弹窗里的行为（换栏、刷新、后退、Esc）在真浏览器里走过，见 docs/rounds/round-30.md。
 */
class SettingsDialogTest {

    private static final Path STATIC = Path.of("src/main/resources/static");

    private static String read(Path p) throws IOException {
        return Files.readString(p, StandardCharsets.UTF_8);
    }

    private static String shell() throws IOException {
        return SourceText.stripComments(read(NodeRunner.API_JS));
    }

    private static String module() throws IOException {
        return SourceText.stripComments(read(NodeRunner.SETTINGS_JS));
    }

    private static String ui() throws IOException {
        return SourceText.stripComments(read(STATIC.resolve("assets/zhiqu-ui.js")));
    }

    /** 从 signature 到它那一层缩进的结尾（两格缩进的「}」）。 */
    private static String fn(String code, String signature) {
        int a = code.indexOf(signature);
        assertTrue(a >= 0, "找不到 " + signature);
        int b = code.indexOf("\n  }\n", a);
        assertTrue(b > a, signature + " 没有结尾");
        return code.substring(a, b);
    }

    @Test
    @DisplayName("地址：五栏各自打得开、认不出的回第一栏、旧地址换得过去、服务器给命令行的链接打开「命令行」那一栏并带上设备码")
    void 地址() throws Exception {
        String service = read(Path.of("src/main/java/com/zhiqu/service/harness/DeviceLoginService.java"));
        Matcher m = Pattern.compile("\"verifyPath\",\\s*\"([^\"]+)\"\\s*\\+\\s*display\\(").matcher(service);
        assertTrue(m.find(), "DeviceLoginService 里找不到 verifyPath 的写法 —— 判据跟着改");
        NodeRunner.run(Path.of("src/test/resources/js/settings-check.js"), NodeRunner.SETTINGS_JS, m.group(1) + "ABCD-EFGH");
    }

    @Test
    @DisplayName("设置弹窗查元素只在弹窗里（弹窗和底下的页面同时在）；它和壳之间那根线（zqShared）由 PageModulesTest 核对")
    void 查元素只在弹窗里() throws IOException {
        String js = module();
        for (String global : List.of("document.querySelector", "document.getElementById", "document.querySelectorAll")) {
            assertFalse(js.contains(global), "settings.js 在整页上找元素（" + global + "）—— 弹窗和底下的页面同时在，要在弹窗里找");
        }
    }

    @Test
    @DisplayName("个人资料读的 stat.xxx 都是接口真的给的字段（原来读 completedTasks，接口给的是 completedTaskCount ——「完成任务」永远是 0）")
    void 统计字段对得上() throws IOException {
        Set<String> real = new TreeSet<>();
        for (java.lang.reflect.Field f : com.zhiqu.dto.StudyStatisticsVO.class.getDeclaredFields()) real.add(f.getName());
        List<String> used = new ArrayList<>();
        Matcher m = Pattern.compile("\\bstat\\.([A-Za-z_]\\w*)").matcher(module());
        while (m.find()) used.add(m.group(1));
        assertTrue(!used.isEmpty(), "settings.js 里一个 stat.xxx 都没扫到 —— 扫空了？");
        List<String> missing = used.stream().filter(u -> !real.contains(u)).distinct().toList();
        assertEquals(List.of(), missing, "读了接口没有的字段（会一直显示 0）；接口有：" + real);
    }

    @Test
    @DisplayName("壳在第一次打开时才 import 模块，带上和自己同一个缓存令牌；页面不直接加载它；离线缓存里有它")
    void 按需加载并带令牌() throws IOException {
        String shell = shell();
        // 第三十一轮起加载收成一个 loadModule（页面模块也走它），设置弹窗只是其中一个
        String load = fn(shell, "function loadModule(rel) {");
        assertTrue(shell.contains("function loadSettingsModule() { return loadModule('settings.js'); }"), "设置弹窗没走 loadModule");
        assertTrue(load.contains("query = new URL(SELF_SRC).search;")
                        && load.contains("import(new URL('assets/' + rel + query, location.href).href)"),
                "模块的地址没带上壳自己的 ?v= —— 发版之后浏览器会拿缓存里的旧模块配新壳（StaticAssetCacheTokenTest 只看页面里写着的引用，看不到这里）");
        assertTrue(shell.contains("var SELF_SRC = (function () { try { return (document.currentScript && document.currentScript.src) || ''; }"),
                "SELF_SRC 要在脚本加载的那一刻取（currentScript 只在同步执行时有值）");
        int pages = 0;
        try (Stream<Path> files = Files.list(STATIC)) {
            for (Path page : files.filter(p -> p.toString().endsWith(".html")).toList()) {
                pages++;
                assertFalse(Pattern.compile("<script[^>]*settings\\.js").matcher(read(page)).find(),
                        page.getFileName() + " 直接加载了 settings.js —— 它应当在第一次打开弹窗时才加载");
            }
        }
        assertTrue(pages >= 14, "只扫到 " + pages + " 个页面");
        assertTrue(read(STATIC.resolve("service-worker.js")).contains("'/assets/settings.js',"), "离线缓存里没有 settings.js —— 断网时设置打不开");
    }

    @Test
    @DisplayName("侧栏只放干活的地方；头像菜单里有设置、成就、专注统计、界面风格、退出，管理员才有后台那一组；名字不再先闪一下设计稿的「王明远」")
    void 侧栏和头像菜单() throws IOException {
        String ui = ui();
        Matcher main = Pattern.compile("main:\\s*\\[(.*?)\\],\\s*\\n", Pattern.DOTALL).matcher(ui);
        assertTrue(main.find(), "找不到 NAV.main");
        for (String gone : List.of("profile.html", "statistics.html", "achievement.html", "admin.html")) {
            assertFalse(main.group(1).contains("'" + gone + "'"), "侧栏里还有 " + gone + " —— 第三十轮起它在头像菜单里");
        }
        String side = fn(ui, "function buildSidebar(){");
        assertTrue(side.contains("navGroup('', NAV.main)"), "侧栏没画干活的那几项");
        for (String gone : List.of("navGroup('数据'", "navGroup('管理'", "zq-trigger", "王明远", ">远<", ">管理员<")) {
            assertFalse(side.contains(gone), "侧栏里还有「" + gone + "」");
        }
        assertTrue(side.contains("openUserMenu(userBtn)"), "点头像没有打开菜单");

        String menu = fn(ui, "function openUserMenu(btn){");
        for (String item : List.of("menuLink('#settings/profile'", "menuLink('#achievements'", "menuLink(NAV.data[0][0]", "data-zq-theme", "data-zq-logout")) {
            assertTrue(menu.contains(item), "头像菜单里少了 " + item);
        }
        int admin = menu.indexOf("if(adminView){");
        assertTrue(admin >= 0 && menu.indexOf("NAV.admin.map(") > admin, "后台那一组要只给管理员画");
        assertTrue(menu.contains("window.zqApi.logout()"), "菜单里的「退出登录」没有接到壳的 logout");
        assertTrue(fn(ui, "function setAdminNav(isAdmin){").contains("adminView = isAdminRole("),
                "服务端角色回来之后没有校正菜单里的后台组（只信本地存的角色，换人登录时会多 / 少一组）");

        String shell = shell();
        // 第三十九轮起左下角只在 zhiqu-ui.js 的 paintUser 一处画（下一页先用上一页记下的画上）；壳的 updateSidebarUser 把 /auth/info 交给它
        String sidebarUser = fn(shell, "function updateSidebarUser(u) {");
        assertTrue(sidebarUser.contains("window.ZQUI.paintUser(box, { name: u.nickname || u.username || '知趣用户', account: u.username || ''"),
                "菜单顶上的名字从 updateSidebarUser 来（经 ZQUI.paintUser）");
        String paint = fn(ui, "function paintUser(box, u){");
        assertTrue(paint.contains("box.dataset.name = name;") && paint.contains("box.dataset.account = u.account || '';"),
                "paintUser 没把名字、账号记到按钮上 —— 头像菜单顶上那一行是从这里读的");
        assertTrue(shell.contains("askNotifyPermission: askNotifyPermission, logout: logout };"), "壳没把 logout 交给 zhiqu-ui.js 的菜单");
    }

    @Test
    @DisplayName("弹窗和地址：关掉时，点菜单进来的后退回去、直接带着 hash 打开的抹掉 hash；换栏只改地址不加历史；Esc 只关最上面那一层")
    void 弹窗和地址() throws IOException {
        String shell = shell();
        String leave = fn(shell, "function leaveDialogHash() {");
        assertTrue(leave.contains("if (dialogPushed) { dialogPushed = false; history.back(); }")
                        && leave.contains("else history.replaceState(history.state, '', location.pathname + location.search);"),
                "关掉弹窗时：点菜单进来的要后退（不留一条「还是这一页」的历史），直接打开的要抹掉 hash（刷新不再弹出来）");
        String watch = fn(shell, "function watchDialogs() {");
        assertTrue(watch.contains("else if (!dialogHashBefore) dialogPushed = true;"),
                "只有从「没有弹窗」跳到弹窗的那一下才算往历史里加了一条");
        assertTrue(fn(shell, "function syncDialog() {").contains("onTab: function (tab) { history.replaceState(history.state, '', '#settings/' + tab); }"),
                "换栏要用 replaceState —— 每换一栏加一条历史的话，后退要按好几下才关得掉");
        assertTrue(fn(shell, "function openModal(opts) {").contains("if (e.key === 'Escape' && mask === lastOf(document.querySelectorAll('.zq-modal-mask'))) close();"),
                "Esc 要只关最上面那一层：设置里点「删除模型」叠出来的确认框，按 Esc 不该把底下的设置一起关掉");
    }

    @Test
    @DisplayName("旧地址照常能用：profile.html / achievement.html 在登录检查之前换成首页的弹窗；页面里没有链接再指向它们；登录跳转带着弹窗的地址")
    void 旧地址() throws IOException {
        String shell = shell();
        String route = fn(shell, "function route() {");
        int legacy = route.indexOf("if (page === 'profile.html' || page === 'achievement.html') {");
        int auth = route.indexOf("await initAuth();");
        assertTrue(legacy >= 0 && auth > legacy, "旧地址要在登录检查之前换过去（没登录时首页会带着弹窗的地址去登录页）");
        assertTrue(route.substring(legacy, auth).contains("location.replace(HOME_PAGE + legacy.legacyHash(page, location.hash));"),
                "旧地址没有换成首页的弹窗");
        assertTrue(fn(shell, "function redirectToLogin() {").contains("(isDialogHash(location.hash) ? location.hash : '')"),
                "去登录页时丢了弹窗的地址 —— 在没登录的浏览器里打开命令行给的链接，登录完就看不到那个确认框了");

        List<String> links = new ArrayList<>();
        int files = 0;
        try (Stream<Path> walk = Files.walk(STATIC)) {
            for (Path f : walk.filter(p -> p.toString().endsWith(".html") || p.toString().endsWith(".js"))
                    .filter(p -> !p.toString().contains("/vendor/")).toList()) {
                files++;
                String text = read(f);
                for (String target : List.of("href=\"profile.html", "href=\"achievement.html", "'profile.html',", "'achievement.html',")) {
                    if (text.contains(target)) links.add(f.getFileName() + " → " + target);
                }
            }
        }
        assertTrue(files >= 17, "只扫到 " + files + " 个文件");
        assertEquals(List.of(), links, "还有地方指向旧的个人中心 / 成就页（它们只为旧书签留着，点进去要多跳一次）");
        for (String page : List.of("profile.html", "achievement.html")) {
            assertTrue(Files.exists(STATIC.resolve(page)), page + " 不能删：书签、历史记录、命令行打印过的链接都还指着它");
        }
    }
}
