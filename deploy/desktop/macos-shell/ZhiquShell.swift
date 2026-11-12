// 知趣象限 —— macOS 原生外壳。
//
// 它做的事：在一个无边框窗口里用 WKWebView 打开这个应用的网站（默认 https://zhiqustudy.com），
// 再加上网页做不了的几件事：系统通知、迷你番茄钟的悬浮胶囊、文件选择和下载（PageView.swift）。
//
// 第一百二十五轮之前它拉起包里的 Java 后端（内嵌 JRE），连用户自己装的 MySQL，窗口里开 http://127.0.0.1:47615。
// 用户定了桌面版给所有下载的人用、数据走网站（docs/desktop-remote-plan.md）：直接连服务器的库就得把主密钥发给每个人，
// 所以改成打开网站 —— 数据只在服务器上，包里不再带 Java、JRE、MySQL。读写本机项目的代码功能由包里的 node 做
// （第一百二十九轮：本机代码助手，LocalAgent.swift —— 页面经 zqLocal 桥叫外壳起它；页面那一侧是方案第 3 步）。
//
// 为什么是 WKWebView：WebKit.framework 是系统自带的，多占 0 字节；无边框（内容顶到窗口边缘）在 AppKit 里就是两个属性的事。

import AppKit
import UserNotifications
import WebKit

// MARK: - 窗口

/// 顶部透明拖拽条 —— 让用户能按住窗口顶部拖动整个窗口。
///
/// 为什么需要它：窗口用了 `fullSizeContentView`（内容铺到标题栏底下，这是"无边框"的做法），
/// 于是 WKWebView 盖住了整个窗口，**把鼠标事件全吃掉**。`isMovableByWindowBackground` 对
/// WKWebView 覆盖的区域不起作用，结果就是单指按住窗口拖不动。
///
/// 高度取 28px：正好是标题栏高度，且落在页面 `.zq-main` 的 30px 上内边距里 ——
/// 盖住的是空白padding，不会挡住任何可点的东西。红绿灯按钮在窗口标题栏视图里、
/// 层级高于 contentView，所以它们照常可点。
final class DragStrip: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    /// 不拦截自己区域之外的事件；区域之内要"可拖"，所以不能返回 nil。
    override func hitTest(_ point: NSPoint) -> NSView? {
        return bounds.contains(convert(point, from: superview)) ? self : nil
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private var window: NSWindow!
    private var webView: PageView!
    private var loadingLabel: NSTextField!
    /// 迷你番茄钟的悬浮面板（MiniPanel.swift）：第一次「缩小到桌面」时才建，之后藏起来再拿出来（页面一直开着、一直跟着那个钟）
    private var miniPanel: NSPanel?
    private var miniPage: PageView?
    /// 迷你模式：主窗口藏着、桌面上只有胶囊。这时系统问「最后一个窗口关了，要不要退出」一律不退（第八十一轮）——
    /// 胶囊是面板，不算普通窗口；原来一点「缩小到桌面」主窗口一藏，整个应用连同后端就退出了（用户：「点击缩小到桌面会直接卡退」）
    private var inMiniMode = false

    /// 自更新（第一百三十二轮）：左下角那颗胶囊 + 问版本、下载、换掉自己
    private var updater: Updater!
    private var updateBadge: UpdateBadge!
    private var updateTimer: Timer?
    private var lastUpdateCheck: Date?
    /// 用户点过 × 的版本：这个版本不再提示，出了更新的再提示
    private var skippedUpdate: String? {
        get { UserDefaults.standard.string(forKey: "skippedUpdate") }
        set { UserDefaults.standard.set(newValue, forKey: "skippedUpdate") }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // 本机代码助手往宿主的管子里写：宿主先退了的话默认的 SIGPIPE 会把整个应用带走
        ignoreBrokenPipe()
        // 应用在前台时系统默认不弹横幅 —— 页面里已经有提示和声音了，这里仍然弹横幅、进通知中心（不带声音，见 PageView.deliverNotification）
        UNUserNotificationCenter.current().delegate = self
        makeWindow()
        startUpdates()
        NSApp.activate(ignoringOtherApps: true)
        // 先清掉以前装上的 Service Worker 和它的缓存，再打开页面（第一百二十六轮）：不然断网时它拿缓存的页面顶上，
        // WebKit 当成载入成功，外壳不说「连不上」。登录态在 localStorage 里，不清
        clearOfflineCache(webView.configuration.websiteDataStore) { [weak self] in self?.openHome() }
    }

    /// 打开网站上的看板（启动时、没连上时按 ⌘R）
    private func openHome() {
        loadingLabel.stringValue = "正在连接 \(Server.url.host ?? "")…"
        loadingLabel.isHidden = false
        webView.load(URLRequest(url: Server.page("dashboard.html")))
    }

    /// 无边框：内容铺满整个窗口，只留左上角三个红绿灯。
    ///
    /// `fullSizeContentView` 让内容视图延伸到标题栏底下，`titlebarAppearsTransparent`
    /// 去掉那条分隔线，`titleVisibility = .hidden` 去掉标题文字。
    /// 保留 `.titled` 样式是有意的 —— 去掉它连红绿灯按钮和拖动都没有了。
    private func makeWindow() {
        let frame = NSRect(x: 0, y: 0, width: 1280, height: 820)
        window = NSWindow(contentRect: frame,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered,
                          defer: false)
        window.title = "知趣象限"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.minSize = NSSize(width: 960, height: 640)
        window.center()
        window.setFrameAutosaveName("ZhiquMainWindow")

        // 文件选择、下载、外部链接、User-Agent、localStorage 持久化都在 PageView.swift 里（它自己当自己的代理）
        webView = PageView(frame: frame)
        webView.autoresizingMask = [.width, .height]
        webView.onMini = { [weak self] action in self?.mini(action) }
        webView.allowedHosts = [Server.url.host ?? ""]
        webView.onLoad = { [weak self] error in self?.loaded(error) }
        // 本机代码助手只给主窗口（迷你窗不接）：包里的 node 跑包里的命令行宿主，服务器就是这个窗口打开的网站
        webView.localAgent = LocalAgent.bundled(server: Server.url).map(LocalAgent.init(config:))

        loadingLabel = NSTextField(labelWithString: "正在启动…")
        loadingLabel.alignment = .center
        loadingLabel.font = .systemFont(ofSize: 14)
        loadingLabel.textColor = .secondaryLabelColor
        loadingLabel.frame = NSRect(x: 0, y: frame.height / 2 - 40, width: frame.width, height: 80)
        loadingLabel.autoresizingMask = [.width, .minYMargin, .maxYMargin]

        let content = NSView(frame: frame)
        content.addSubview(webView)
        content.addSubview(loadingLabel)
        // 拖拽条压在最上层：它必须在 webView 之后添加，否则 webView 会盖住它。
        let drag = DragStrip(frame: NSRect(x: 0, y: frame.height - 28, width: frame.width, height: 28))
        drag.autoresizingMask = [.width, .minYMargin]
        content.addSubview(drag)
        // 自更新的胶囊（第一百三十二轮）：左下角，没新版本时不出现；压在网页上面，只在自己那一块吃点击。
        // 往上让开侧栏底部那块（头像 + 用户名，约 44pt）：压在名字上会挡住「点开用户菜单」
        updateBadge = UpdateBadge()
        updateBadge.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(updateBadge)
        NSLayoutConstraint.activate([
            updateBadge.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16),
            updateBadge.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -72),
        ])
        window.contentView = content
        window.makeKeyAndOrderFront(nil)
    }

    // MARK: - 自更新（第一百三十二轮）

    /// 启动时问一次，之后每 6 小时问一次；从后台切回来时最多一小时问一次
    /// （用户不会为了更新去重启应用，但也不能每分钟都去问服务器）
    private func startUpdates() {
        updater = Updater()
        updater.onChange = { [weak self] phase in self?.apply(phase) }
        updateBadge.onClick = { [weak self] in self?.tapUpdate() }
        updateBadge.onSkip = { [weak self] in
            guard let self else { return }
            if let release = self.updater.phase.release { self.skippedUpdate = release.version }
            self.updateBadge.show(.idle)
        }
        checkForUpdates()
        updateTimer = Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { [weak self] _ in
            self?.checkForUpdates()
        }
    }

    private func checkForUpdates() {
        lastUpdateCheck = Date()
        updater.check()
    }

    /// 点胶囊：有新版本就开始下载，下载完就重启（中间那一下是用户自己点的，不会打断正在干的事）
    private func tapUpdate() {
        switch updater.phase {
        case .available: updater.download()
        case .ready: updater.restart()
        default: break
        }
    }

    private func apply(_ phase: UpdatePhase) {
        // 用户点过 × 的那个版本不再冒出来；出了更新的版本照样提示
        if case .available(let release) = phase, release.version == skippedUpdate { return }
        updateBadge.show(phase)
    }

    /// 页面载入完了就收起「正在连接」；没载入成（断网、服务器在重启）就说清楚、告诉人怎么重来
    private func loaded(_ error: Error?) {
        guard let error else {
            loadingLabel.isHidden = true
            webView.isHidden = false
            return
        }
        // 没载入成时 WebKit 照样留着上一页（或者 502 的白页）：说明压在一个点什么都没反应的旧页面上，看着像卡死。
        // 页面先藏起来，只剩说明；载入成了再露出来（第一百二十六轮）
        webView.isHidden = true
        fail("连不上 \(Server.url.host ?? "服务器")：\(error.localizedDescription)\n数据都在服务器上，断网时看不了。联网后按 ⌘R 重新载入。")
    }

    /// 「显示 → 重新载入」（⌘R）：页面里有焦点时 WKWebView 自己接；没有时（比如刚才没连上、页面是空的）落到这里
    @objc func reload(_ sender: Any?) {
        if webView.url == nil {
            openHome()
        } else {
            loadingLabel.stringValue = "正在连接 \(Server.url.host ?? "")…"
            loadingLabel.isHidden = false
            webView.reload()
        }
    }

    // MARK: 迷你番茄钟（第五十一轮）

    /// 页面说的（PageView 只转 shrink / expand 这两种）：看板上「缩小到桌面」、胶囊上「展开」
    private func mini(_ action: String) {
        switch action {
        case "shrink": showMini()
        case "expand": showMain()
        default: break
        }
    }

    /// 主窗口藏起来、胶囊出来。不抢焦点：用户多半正要切去别的应用干活
    private func showMini() {
        if miniPanel == nil {
            let page = PageView(frame: NSRect(origin: .zero, size: miniPanelSize))
            page.onMini = { [weak self] action in self?.mini(action) }
            page.allowedHosts = [Server.url.host ?? ""]
            miniPage = page
            miniPanel = makeMiniPanel(page: page)
            page.load(URLRequest(url: Server.page("mini.html")))
        } else {
            // 再缩小一次就重新载入胶囊（第五十八轮 review）：主窗口那边可能退出过、重新登录过、换了账号 —— 两个 WKWebView 之间不传 storage 事件，
            // 胶囊自己看不出来：退出再登录之后它一直写「在主窗口登录后再用」，换了账号还在看上一个人的钟
            miniPage?.reload()
        }
        // 先把胶囊放出来、记下在迷你模式，再藏主窗口：反过来的话主窗口一藏，屏幕上一个窗口都没有
        inMiniMode = true
        miniPanel?.orderFrontRegardless()
        window.orderOut(nil)
    }

    /// 胶囊收起、主窗口回来并到最前（点「展开」、点 Dock 图标、点通知）
    private func showMain() {
        inMiniMode = false
        miniPanel?.orderOut(nil)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    /// 点 Dock 图标：回到主窗口（迷你模式下主窗口是藏着的，不处理的话点了什么都不出来）
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showMain()
        return true
    }

    /// 迷你模式下切回这个应用（Cmd+Tab、从别处切过来）：就是要主窗口。胶囊本身点了不会把应用切到前台（不抢焦点），
    /// 所以应用到了前台一定是人特意切过来的 —— 不处理的话切过来什么窗口都没有
    func applicationDidBecomeActive(_ notification: Notification) {
        if miniPanel?.isVisible == true && !window.isVisible { showMain() }
        // 切回前台顺手问一次（一小时最多一次）：开机一直不关的应用也能等到新版本
        if let last = lastUpdateCheck, Date().timeIntervalSince(last) > 3600 { checkForUpdates() }
    }

    private func fail(_ message: String) {
        loadingLabel.stringValue = message
        loadingLabel.isHidden = false
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list])
    }

    /// 点通知：把窗口叫到前面（迷你模式下胶囊收起，和点「展开」一样）。
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        showMain()
        completionHandler()
    }

    /// 点红色按钮关掉主窗口就退出；迷你模式下主窗口只是藏起来，不退
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return !inMiniMode
    }

    /// 退出时本机代码助手还在跑：SIGTERM 给它（中断、收掉它起的后台命令），不留在后台
    func applicationWillTerminate(_ notification: Notification) {
        updateTimer?.invalidate()
        webView?.localAgent?.terminate()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.mainMenu = makeZhiquApplicationMenu()
app.run()
