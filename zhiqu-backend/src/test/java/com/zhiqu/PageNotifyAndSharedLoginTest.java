package com.zhiqu;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 第二十五轮：用户 2026-10-03 定的两件事 ——「页面开着时到点弹通知 / 响一声」「同一个浏览器会话里的标签页共享登录」。
 * 行为在 node 上跑发布的实现（两个「标签页」真的用 BroadcastChannel 互相问；该提醒的是哪几条）；这里另外钉接线 ——
 * 这两件事断了都不报错：没接上的话新标签页照旧要登录、到点照旧一点动静没有。
 */
class PageNotifyAndSharedLoginTest {

    private static final Path STATIC = Path.of("src/main/resources/static");

    private static String api() throws Exception {
        return SourceText.stripComments(Files.readString(STATIC.resolve("assets/zhiqu-api.js"), StandardCharsets.UTF_8));
    }

    @Test
    @DisplayName("标签页共享登录：借令牌、退出和改密码告诉别的标签页、只动同一张令牌的（node 上两个标签页真的互相问）")
    void 共享登录的行为() throws Exception {
        NodeRunner.run(Path.of("src/test/resources/js/auth-share-check.js"), NodeRunner.API_JS);
    }

    @Test
    @DisplayName("共享登录接上了：没令牌先借再认证；落地页借到了就直接进去；退出、改密码都广播")
    void 共享登录的接线() throws Exception {
        String code = api();
        int borrow = code.indexOf("if (!token()) await borrowToken();");
        int auth = code.indexOf("await initAuth();", Math.max(0, borrow));
        assertTrue(borrow >= 0 && auth > borrow, "页面启动时要先向别的标签页借令牌，再去认证 —— 反过来就是先被踢去登录页");
        assertTrue(code.contains("if (!token() && await borrowToken()) { location.href = safeNext("), "落地页借到了令牌要直接进去");
        assertTrue(code.contains("clearAuth(); announceLogout(had);"), "退出要告诉别的标签页");
        // 第三十轮起改密码在设置弹窗里，换令牌收在壳的 adoptNewToken（PasswordChangeKeepsSessionTest 钉着模块确实调它）
        assertTrue(code.contains("announceNewToken(before, fresh);"), "改密码换了令牌要告诉别的标签页（旧令牌已经作废）");
    }

    @Test
    @DisplayName("页面里的提醒：该提醒的是哪几条（到点、过去不到 15 分钟、没提醒过、按业务时区）")
    void 页面里的提醒的行为() throws Exception {
        NodeRunner.run(Path.of("src/test/resources/js/reminder-notify-check.js"), NodeRunner.API_JS);
    }

    @Test
    @DisplayName("页面里的提醒接上了：登录后每页都看着；授权只在点击里问；番茄钟到点通知")
    void 页面里的提醒的接线() throws Exception {
        String code = api();
        int watch = code.indexOf("        watchReminders();");
        int boots = code.indexOf("await pageModule.boots[page](zqShared);");
        assertTrue(watch >= 0 && boots > watch, "登录后的页面要在启动时开始看着提醒");
        assertTrue(code.contains("api.get('/reminder/upcoming')"), "提醒清单要从 /reminder/upcoming 取");
        int form = code.indexOf("async function openTaskForm(id, onSaved)");
        assertTrue(form >= 0 && code.indexOf("refreshUpcomingReminders();", form) > form
                        && code.indexOf("refreshUpcomingReminders();", form) < code.indexOf("\n  }\n", form),
                "保存任务之后要马上刷新提醒清单 —— 不然 5 分钟后的提醒要等 10 分钟那一趟才进清单");
        assertTrue(code.contains("if (plan.body.reminderTime || plan.body.deadline) askNotifyPermission();"),
                "保存带提醒的任务时要请求通知授权（在点击里，浏览器才肯弹）");
        assertTrue(code.contains("writeSeen(seen);   ") && code.indexOf("writeSeen(seen);") < code.indexOf("due.forEach(function (r) { pageNotify("),
                "先记下「提醒过了」再提醒：另一个标签页才不会再提醒一遍");
        String dash = SourceText.stripComments(Files.readString(STATIC.resolve("dashboard.html"), StandardCharsets.UTF_8));
        assertTrue(dash.contains("window.zqApi.notify('专注结束'"), "番茄钟到点要通知");
        assertTrue(dash.contains("window.zqApi.askNotifyPermission();") && dash.indexOf("window.zqApi.askNotifyPermission();") < dash.indexOf("running=true; elStart.textContent='暂停'"),
                "点「开始」时请求通知授权");
    }
}
