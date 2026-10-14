package com.zhiqu.desktop;

import com.zhiqu.SourceText;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

/**
 * 桌面外壳里的页面能选文件、能下载（{@code deploy/desktop/macos-shell/PageView.swift}，2026-10-01）。
 *
 * <p>WKWebView 不实现代理方法就不做这些事，<b>而且不报错</b>：用户报「Wiki 导入来源 → 上传文件解析，点了没反应」——
 * 文件选择面板根本不出来，WebKit 直接当成取消（AI 助手上传资料、换头像同样）；页面的导出 / 下载原件则把整个应用窗口
 * 导航成那份文件的原文，无边框窗口没有后退。两样都是在真的 WKWebView 里实测的。
 *
 * <p>这里把 PageView.swift 和一个检查程序一起编译，在真的 WKWebView 里真点 file input、真点 a[download]、
 * 真走外部链接 —— 只有面板换成不开窗口的桩。只在 macOS 上有意义；没有 swiftc 明确失败，
 * 要跳过写明 {@code -Dzhiqu.skipSwiftTests=true}（和 {@link DesktopCdsCacheTest} 同一个约定）。
 */
class DesktopPageViewTest {

    private static final Path SHELL = Path.of("../deploy/desktop/macos-shell");

    @TempDir
    Path tmp;

    @Test
    @DisplayName("文件选择：面板出来、单选 / 多选照 input 的设置、选中的文件真到了页面上、取消时页面收到 cancel")
    void 文件选择() throws Exception {
        Map<String, String> out = runCheck();
        assertEquals("false", out.get("one.multiple"), "单选的 input 面板没出来（panel-not-shown = WebKit 当成了取消），或者被配成了多选");
        assertEquals("one:change:1:笔记 A.txt:内容甲", out.get("one.result"), "选中的文件没有到页面上");
        assertEquals("true", out.get("many.multiple"), "multiple 的 input 面板不许多选");
        assertEquals("many:change:2:笔记 A.txt|b.md:内容甲", out.get("many.result"));
        assertEquals("one:cancel", out.get("cancel.result"), "在面板里取消，页面应当收到 cancel");
    }

    @Test
    @DisplayName("下载：存到选的位置、窗口不导航到 blob；已存在的文件按替换处理；在保存面板里取消不算失败、写不进去要说；外部链接交给系统浏览器")
    void 下载与外部链接() throws Exception {
        Map<String, String> out = runCheck();
        assertEquals("true", out.get("download.saved"), "a[download] 的内容没存下来");
        assertEquals("知识库.zip", out.get("download.suggested"), "保存面板里的默认文件名应当是页面给的那个");
        assertEquals("true", out.get("download.stayed"), "下载时整个窗口被导航走了 —— 应用里只剩文件原文、没有后退");
        assertEquals("true", out.get("replace.saved"), "存到已存在的文件上失败了（WKDownload 不肯覆盖，要先删）");
        assertEquals("0", out.get("replace.failures"));
        assertEquals("true", out.get("saveCancel.nothingWritten"));
        assertEquals("0", out.get("saveCancel.failures"), "用户在保存面板里点取消，被当成失败弹了提示");
        assertEquals("true", out.get("saveCancel.stayed"));
        assertEquals("1", out.get("writeFail.reported"), "写不进去（只读文件夹）的下载一声不吭 —— WebKit 报的是「已取消」，按取消滤掉就成了这样");
        assertEquals("true", out.get("writeFail.namesPlace"), "写不进去时要说出是哪儿（WebKit 给的说明是空的）");
        assertEquals("https://example.com/x", out.get("external.opened"), "外部链接没交给系统浏览器");
        assertEquals("true", out.get("external.stayed"), "外部链接在应用窗口里打开了");
    }

    /**
     * 第二十五轮：页面开着时到点提醒。WKWebView 里网页的 Notification 授权一请求就是「拒绝」（实测），所以页面在桌面应用里
     * 走 {@code window.webkit.messageHandlers.zqNotify} 这座桥、外壳发 macOS 原生通知。这里真的从页面里发消息过来（通知中心换成桩）。
     */
    @Test
    @DisplayName("页面经 zqNotify 桥发通知、要授权；认不出的消息不理；标题和正文截断")
    void 通知的桥() throws Exception {
        Map<String, String> out = runCheck();
        assertEquals("1", out.get("bridge.authorize"), "页面要授权时没有转给系统");
        assertEquals("任务提醒|发周报|zq-reminder-7", out.get("bridge.first"), "通知没有原样转出去");
        assertEquals("专注结束|休息一下|专注结束", out.get("bridge.defaultTag"), "没给标识时用标题当标识");
        assertEquals("3", out.get("bridge.count"), "认不出的消息（错的 action、不是对象）不该发通知");
        assertEquals(String.valueOf(80 + 1 + 240 + 1 + 1), out.get("bridge.capped"), "标题 80 字、正文 240 字之外要截掉");
    }

    /**
     * 第五十一轮：迷你番茄钟（docs/mini-pomodoro-plan.md 第 3 步）。看板上「缩小到桌面」、胶囊上「展开」经 {@code zqMini} 这座桥告诉外壳；
     * 迷你窗是另一个 PageView，和主窗口共用一份网站数据 —— 看的是同一个钟。面板建出来核对设定，不放到屏幕上（用户说过预览不要弹窗口）。
     */
    @Test
    @DisplayName("迷你番茄钟：zqMini 只认 shrink / expand；两个页面共用一份网站数据时 localStorage 互相看得到；悬浮面板总在最前、不抢焦点、透明、中间拖、两边的按钮点得到")
    void 迷你番茄钟() throws Exception {
        Map<String, String> out = runCheck();
        assertEquals("shrink,expand", out.get("mini.actions"), "zqMini 转给外壳的不对（只认 {action:'shrink'} / {action:'expand'}，别的一律不理）");
        assertEquals("true", out.get("mini.noNotify"), "zqMini 上的消息串到了通知那边");
        assertEquals("running", out.get("twin.read"), "两个页面共用一份网站数据时读不到对方写的 localStorage —— 迷你窗和主窗口不是同一个钟");
        // 到点「只响一次」靠的是这把锁（只记一次另有幂等键兜着）：两个 WKWebView 拿的是同一把（2026-10-09 实测）
        assertEquals("lock:held", out.get("twin.lock"), "主窗口和迷你窗的浏览器锁不是同一把 —— 到点两边可能各响一次");
        // storage 事件实测不在两个 WKWebView 之间传（放进窗口里也不传）：页面不靠它 —— 一秒一跳、切回来（visibilitychange）马上按存的刷一次。
        // 只要求这一步走完了；哪天 WebKit 开始传了，这里不会红
        assertTrue(out.containsKey("twin.event"), "storage 事件那一步没走完");
        assertEquals("false", out.get("panel.visible"), "建面板的时候就放到屏幕上了");
        assertEquals("true", out.get("panel.floating"), "面板不是总在最前");
        assertEquals("true", out.get("panel.nonactivating"), "点面板会把应用切到前台（抢了别的应用的焦点）");
        assertEquals("true", out.get("panel.borderless"), "面板有标题栏");
        assertEquals("true", out.get("panel.allSpaces"), "换个桌面空间、别的应用全屏时迷你窗就不见了");
        assertEquals("true", out.get("panel.clear"), "面板不透明 / 有方的影子 —— 胶囊外面露出一块方的");
        assertEquals("true", out.get("panel.staysWhenInactive"), "应用切到后台时面板跟着藏起来 —— 迷你窗恰恰是给在别的应用里干活的时候看的");
        assertEquals("true", out.get("panel.canBecomeKey"), "无边框面板当不了键窗口：胶囊上的按钮用键盘按不到");
        assertEquals("300x68", out.get("panel.size"));
        assertEquals("ZhiquMiniPanel", out.get("panel.autosave"), "面板不记位置");
        assertEquals("true", out.get("panel.dragMiddle"), "胶囊中间拖不动（WKWebView 把鼠标事件吃了）");
        assertEquals("true", out.get("panel.buttonsClickable"), "拖动区域盖住了开始 / 暂停或展开按钮");
    }

    @Test
    @DisplayName("外壳接上迷你窗：两个页面的 zqMini 都接到外壳；缩小时主窗口藏、面板出，展开 / 点 Dock 图标 / 点通知都回到主窗口；打包脚本编进 MiniPanel.swift")
    void 外壳接上迷你窗() throws Exception {
        String shell = SourceText.stripComments(Files.readString(SHELL.resolve("ZhiquShell.swift"), StandardCharsets.UTF_8));
        assertTrue(shell.contains("webView.onMini = { [weak self] action in self?.mini(action) }"), "主窗口的页面说「缩小到桌面」，外壳没接");
        assertTrue(shell.contains("page.onMini = { [weak self] action in self?.mini(action) }"), "迷你窗的页面说「展开」，外壳没接");
        assertTrue(shell.contains("miniPanel = makeMiniPanel(page: page)") && shell.contains("/mini.html"), "迷你窗不是 MiniPanel.swift 建的面板、或者没打开 mini.html");
        String showMini = shell.substring(shell.indexOf("private func showMini()"), shell.indexOf("private func showMain()"));
        assertTrue(showMini.contains("window.orderOut(nil)") && showMini.contains("miniPanel?.orderFrontRegardless()"),
                "缩小时要主窗口藏起来、面板出来（不抢焦点地出来）：\n" + showMini);
        // 第五十八轮 review：面板只建一次，之后藏起来再拿出来 —— 主窗口退出再登录、换了账号，胶囊看不出来（两个 WKWebView 之间不传 storage 事件），
        // 一直写「在主窗口登录后再用」。再缩小时重新载入胶囊
        int built = showMini.indexOf("miniPanel = makeMiniPanel(page: page)");
        assertTrue(built > 0 && showMini.indexOf("miniPage?.reload()", built) > built,
                "面板已经建过时，再缩小没有重新载入胶囊（退出再登录之后它一直是「在主窗口登录后再用」）：\n" + showMini);
        String showMain = shell.substring(shell.indexOf("private func showMain()"), shell.indexOf("func applicationShouldHandleReopen"));
        assertTrue(showMain.contains("miniPanel?.orderOut(nil)") && showMain.contains("window.makeKeyAndOrderFront(nil)"), "展开时面板没收、主窗口没回来：\n" + showMain);
        assertTrue(shell.contains("func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {\n        showMain()"),
                "迷你模式下点 Dock 图标，主窗口不出来");
        assertTrue(shell.contains("func applicationDidBecomeActive(_ notification: Notification) {\n        if miniPanel?.isVisible == true && !window.isVisible { showMain() }"),
                "迷你模式下 Cmd+Tab 切回应用，什么窗口都没有");
        String notified = shell.substring(shell.indexOf("didReceive response: UNNotificationResponse"));
        assertTrue(notified.substring(0, notified.indexOf("completionHandler()")).contains("showMain()"), "迷你模式下点通知，主窗口不出来");
        String script = Files.readString(Path.of("../deploy/desktop/package-macos-native.sh"), StandardCharsets.UTF_8);
        assertTrue(script.contains("macos-shell/MiniPanel.swift\""), "打包脚本没把 MiniPanel.swift 编进外壳");
    }

    @Test
    @DisplayName("外壳用的就是 PageView：不另设代理（uiDelegate 是 weak 的，另设一个当场就被释放）")
    void 外壳接上的是PageView() throws Exception {
        String shell = SourceText.stripComments(Files.readString(SHELL.resolve("ZhiquShell.swift"), StandardCharsets.UTF_8));
        assertTrue(shell.contains("webView = PageView(frame:"), "ZhiquShell.swift 没有用 PageView 建页面");
        assertFalse(shell.contains(".uiDelegate =") || shell.contains(".navigationDelegate ="),
                "ZhiquShell.swift 另设了代理 —— 会顶掉 PageView 自己的文件选择 / 下载处理");
        assertFalse(shell.contains("WKWebView("), "ZhiquShell.swift 里另建了一个裸的 WKWebView");
        String script = Files.readString(Path.of("../deploy/desktop/package-macos-native.sh"), StandardCharsets.UTF_8);
        assertTrue(script.contains("macos-shell/PageView.swift\""), "打包脚本没把 PageView.swift 编进外壳");
        assertTrue(shell.contains("UNUserNotificationCenter.current().delegate = self"),
                "外壳没接通知中心的代理 —— 应用在前台时系统不弹横幅，点通知也不会把窗口叫到前面");
    }

    @Test
    @DisplayName("原生编辑菜单：Cmd+A/C/X/V/Z/Shift+Z 真正操作 Wiki 的 contenteditable 与 textarea；检查窗口不显示、不抢焦点")
    void 原生编辑快捷键() throws Exception {
        Map<String, String> out = runCheck();
        assertEquals("true", out.get("edit.responderTargets"), "生产菜单必须由当前 firstResponder 接收编辑命令，不能写死到 Wiki 或主窗口");
        assertEquals("true", out.get("edit.windowHidden"));
        assertEquals("true", out.get("edit.windowStayedHidden"), "验证快捷键时不许显示窗口或抢走用户的焦点");
        for (String command : new String[]{"select", "copy", "cut", "undoCut", "paste", "undo", "redo",
                "textarea.select", "textarea.copy", "textarea.paste", "textarea.undo"}) {
            assertEquals("true", out.get("edit." + command + ".handled"), "原生菜单没有处理快捷键 " + command);
        }
        assertEquals("原始正文甲乙", out.get("edit.select.selected"), "Cmd+A 没有选中 Wiki 正文");
        assertEquals("true", out.get("edit.copy.clipboard"), "Cmd+C 没把实际选区复制到系统粘贴板");
        assertEquals("", out.get("edit.cut.text"), "Cmd+X 没有剪切实际选区");
        assertEquals("原始正文甲乙", out.get("edit.undoCut.text"), "Cmd+Z 没有撤销剪切");
        assertEquals("粘贴新正文甲", out.get("edit.paste.text"), "Cmd+V 没有从系统粘贴板粘贴到 Wiki 正文");
        assertEquals("原始正文甲乙", out.get("edit.undo.text"), "Cmd+Z 没有撤销粘贴");
        assertEquals("粘贴新正文甲", out.get("edit.redo.text"), "Cmd+Shift+Z 没有重做粘贴");
        assertEquals("输入框正文丙丁", out.get("edit.textarea.select.selected"), "Cmd+A 没有选中 textarea 正文");
        assertEquals("true", out.get("edit.textarea.copy.clipboard"), "textarea 的 Cmd+C 没复制到系统粘贴板");
        assertEquals("粘贴新正文", out.get("edit.textarea.paste.text"), "textarea 的 Cmd+V 没替换实际选区");
        assertEquals("输入框正文丙丁", out.get("edit.textarea.undo.text"), "textarea 的 Cmd+Z 没撤销粘贴");

        String shell = SourceText.stripComments(Files.readString(SHELL.resolve("ZhiquShell.swift"), StandardCharsets.UTF_8));
        assertTrue(shell.contains("app.mainMenu = makeZhiquApplicationMenu()"), "外壳没有安装真实的原生菜单，WKWebView 不会自动提供宿主的编辑快捷键");
    }

    /** 编译并跑一次检查程序。 */
    private Map<String, String> runCheck() throws Exception {
        Assumptions.assumeTrue(System.getProperty("os.name", "").toLowerCase().contains("mac"), "外壳只在 macOS 上编译");
        Assumptions.assumeFalse(Boolean.getBoolean("zhiqu.skipSwiftTests"), "按 -Dzhiqu.skipSwiftTests=true 跳过");
        if (!new File("/usr/bin/swiftc").canExecute()) {
            fail("这台 Mac 上没有 swiftc（装 Xcode 命令行工具：xcode-select --install），外壳的文件选择 / 下载验不了；"
                    + "确实要跳过就加 -Dzhiqu.skipSwiftTests=true");
        }
        Path src = Files.createDirectories(tmp.resolve("src"));
        Files.copy(Path.of("src/test/resources/swift/page-view-check.swift"), src.resolve("main.swift"));
        Files.copy(SHELL.resolve("PageView.swift"), src.resolve("PageView.swift"));
        Files.copy(SHELL.resolve("MiniPanel.swift"), src.resolve("MiniPanel.swift"));
        Path bin = tmp.resolve("check");
        run(600, "/usr/bin/swiftc", "-O", "-framework", "AppKit", "-framework", "WebKit", "-framework", "UserNotifications", "-o", bin.toString(),
                src.resolve("main.swift").toString(), src.resolve("PageView.swift").toString(), src.resolve("MiniPanel.swift").toString());
        Path work = Files.createDirectories(tmp.resolve("work"));
        String text = run(90, bin.toString(), work.toString());
        Map<String, String> map = new HashMap<>();
        for (String line : text.split("\n")) {
            int eq = line.indexOf('=');
            if (eq > 0) map.put(line.substring(0, eq), line.substring(eq + 1));
        }
        assertEquals("true", map.get("done"), "检查程序没有走完：\n" + text);
        return map;
    }

    /** 跑一个程序、等它结束、拿回输出（DesktopWebKitLayoutTest 也用）。 */
    static String run(int timeoutSeconds, String... cmd) throws Exception {
        // 输出写文件、等进程本身（不读到 EOF）：WebKit 的子进程可能晚一点才关掉继承的管道
        Path log = Files.createTempFile("page-view-check", ".log");
        try {
            Process p = new ProcessBuilder(cmd).redirectErrorStream(true).redirectOutput(log.toFile()).start();
            p.getOutputStream().close();
            if (!p.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
                p.destroyForcibly();
                fail("超时：" + String.join(" ", cmd) + "\n" + Files.readString(log));
            }
            String out = Files.readString(log, StandardCharsets.UTF_8);
            assertEquals(0, p.exitValue(), () -> String.join(" ", cmd) + " 失败：\n" + out);
            return out;
        } finally {
            Files.deleteIfExists(log);
        }
    }
}
