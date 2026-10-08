package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 番茄钟全站共用一个钟（第四十九轮，迷你番茄钟第 1 步 —— docs/mini-pomodoro-plan.md）。
 * 原来番茄钟是看板页的一段内联脚本、状态在那一页的内存里：切到别的页就没了，不记、到点也不提醒；两个看板标签页各算各的。
 * 钟挪进了壳（zhiqu-api.js），状态存在 localStorage；看板的卡片（pages/dashboard.js）只画、只把按钮交过去。
 * 行为判据跑在 node 上，直接加载发布的实现：pomo-shared-check.js（壳里的钟，两个「标签页」共用一份存储、一把锁）、pomo-card-check.js（看板的卡片）。
 */
class PomodoroSharedTest {

    private static final Path STATIC = Path.of("src/main/resources/static");

    @Test
    @DisplayName("壳里的钟：换一页还在；按结束时刻倒数；暂停、继续；到点只记一次只提醒一次、幂等键是 id；关着时到点补到那一天、不响；钟往回拨只挪一遍；别的账号看不见；存不进存储照样能用")
    void 壳里的钟() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/pomo-shared-check.js"), NodeRunner.API_JS), "pomo-shared-check.js 没有全绿");
    }

    @Test
    @DisplayName("看板的卡片：画得对（待开始 / 专注中 / 已暂停 / 已完成），按钮交给壳，看板重新取几遍按钮只接一次")
    void 看板的卡片() throws Exception {
        assertTrue(NodeRunner.run(Path.of("src/test/resources/js/pomo-card-check.js"), STATIC.resolve("assets/pages/dashboard.js")),
                "pomo-card-check.js 没有全绿");
    }

    @Test
    @DisplayName("接线：每一页登录之后看着这个钟（一秒一跳、别的页改了马上跟上）；模块拿得到它；看板一启动就接卡片；侧栏有那一行；退出时删掉")
    void 接线() throws Exception {
        String js = SourceText.stripComments(Files.readString(NodeRunner.API_JS, StandardCharsets.UTF_8));
        String route = js.substring(js.indexOf("function route() {"), js.indexOf("window.zqApi = {"));
        int auth = route.indexOf("await initAuth();"), watch = route.indexOf("watchPomo();");
        assertTrue(auth > 0 && watch > auth, "每一页要在登录之后看着番茄钟（按人分开存的，登录前不知道是谁）：\n" + route);
        String watchBody = SourceText.functionBody(js, "function watchPomo()");
        assertTrue(watchBody.contains("setInterval(pomoTick, 1000);")
                        && watchBody.contains("window.addEventListener('storage', function (e) { if (e.key == null || e.key === pomoKey()) pomoTick(); });")
                        && watchBody.contains("if (!document.hidden) pomoTick();"),
                "一秒一跳 / 别的页改了马上跟上 / 切回来马上刷一次，少了哪个：\n" + watchBody);
        assertTrue(js.contains("updatePomoCount: updatePomoCount, pomo: pomo,"), "zqShared 里没有 pomo —— 页面模块拿不到这个钟");
        assertTrue(SourceText.functionBody(js, "function logout()").contains("drafts.clearUser(); writePomo(null);"),
                "退出时没删番茄钟 —— 任务名留在公用电脑上");

        String board = SourceText.pageModule("dashboard.js");
        String boot = SourceText.functionBody(board, "async function bootDashboard()");
        assertTrue(boot.startsWith("async function bootDashboard() {\n  wirePomo();"), "看板一启动就要先接上番茄钟的卡片（在任何请求之前 —— 网慢时卡片不该一直是 25:00）：\n"
                + boot.substring(0, Math.min(200, boot.length())));

        String ui = SourceText.stripComments(Files.readString(STATIC.resolve("assets/zhiqu-ui.js"), StandardCharsets.UTF_8));
        String side = SourceText.functionBody(ui, "function buildSidebar()");
        assertTrue(side.contains("'<a class=\"zq-side-pomo\" href=\"dashboard.html\" hidden>"), "侧栏没有番茄钟那一行（别的页看不到「专注中」）");
        assertTrue(side.indexOf("zq-side-pomo") < side.indexOf("class=\"zq-user"), "番茄钟那一行要在头像上面");
    }
}
