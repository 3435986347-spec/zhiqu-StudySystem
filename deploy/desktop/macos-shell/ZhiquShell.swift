// 知趣象限 —— macOS 原生外壳。
//
// 它做三件事：拉起打包在 Contents/Resources 里的 JVM、等后端把端口写出来、
// 在一个无边框窗口里用 WKWebView 显示页面。
//
// 为什么是 WKWebView 而不是 JavaFX WebView：
//   - WebKit.framework 是系统自带的，多占 0 字节；JavaFX 的 WebView 要自带一份 WebKit，
//     光 mac-aarch64 一个平台就 37MB。
//   - 它就是 Safari 的引擎，常驻内存，不需要先初始化一套 GUI 工具包。
//   - 无边框（内容顶到窗口边缘）在 AppKit 里就是两个属性的事。
//
// 为什么外壳负责显示、而不是让后端弹浏览器：
//   用户要的是「一个应用」，不是「一个会打开浏览器的东西」。后端那条开浏览器的路仍然留着，
//   给直接 java -jar 跑的场景用 —— 区分靠 -Dzhiqu.desktop.port-file 这个属性在不在。

import AppKit
import WebKit

// MARK: - 后端进程

/// 拉起 JVM，并在退出时确保它跟着一起走。
final class Backend {
    /// 桌面版用<b>固定端口</b>，不是随机端口。
    ///
    /// 原因是「记住登录」：WKWebView 的 localStorage 按 origin（scheme+host+**port**）隔离，
    /// 端口每次随机的话，上次记住的 token 这次就在另一个 origin 里、读不到 —— 于是每次都要
    /// 重新登录。固定端口让 origin 稳定，localStorage 才跨启动持久。
    ///
    /// 选一个不常用的高位端口，尽量避开冲突；真撞上了会走「单实例」那条：另一个我们自己的
    /// 实例已经在跑，就直接连过去，不再起第二个后端。
    static let port = 47615
    private let process = Process()
    private let portFile: URL
    /// 已经有我们的实例在跑，这次只是连过去，没有自己拉 JVM。
    private var attached = false
    /// 应用类的 CDS 归档（启动快一半，见 CdsCache.swift）。第一次运行时顺带生成，退出时才落成正式文件。
    private var cds: CdsCache?

    /// 端口文件放在临时目录，每次启动一个新的 —— 不能复用固定路径：
    /// 上一次遗留的文件会让外壳立刻连到一个已经不存在的端口上。
    init() {
        portFile = FileManager.default.temporaryDirectory
            .appendingPathComponent("zhiqu-port-\(ProcessInfo.processInfo.processIdentifier)")
        try? FileManager.default.removeItem(at: portFile)
    }

    /// 固定端口上是不是已经有我们的后端在响应。用于单实例：再次双击不该起第二个 JVM。
    private func alreadyRunning() -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(Backend.port)/index.html") else { return false }
        var request = URLRequest(url: url, timeoutInterval: 1.5)
        request.httpMethod = "HEAD"
        var reachable = false
        let sem = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { _, response, _ in
            if let http = response as? HTTPURLResponse, http.statusCode == 200 { reachable = true }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 2)
        return reachable
    }

    func start() throws {
        if alreadyRunning() {
            // 已有实例：这次不拉 JVM，界面直接连过去。localStorage 因为 origin 相同而共享，
            // 上次记住的登录态在。
            attached = true
            return
        }
        let resources = Bundle.main.resourceURL!
        let java = resources.appendingPathComponent("runtime/Contents/Home/bin/java")
        let jar = try FileManager.default
            .contentsOfDirectory(at: resources.appendingPathComponent("app"),
                                 includingPropertiesForKeys: nil)
            .first { $0.pathExtension == "jar" }!

        let home = FileManager.default.homeDirectoryForCurrentUser
        // 应用包路径是中文的：JDK 17 的应用类归档对它只归档一小部分，从 ASCII 路径的副本跑（见 CdsCache.swift 的 AppStage）
        let runJar = AppStage.runnableJar(bundleApp: resources.appendingPathComponent("app"), jar: jar,
                                          root: home.appendingPathComponent(".zhiqu/app"))
        let cache = CdsCache(directory: home.appendingPathComponent(".zhiqu/cds"), jar: runJar, java: java)
        cds = cache

        process.executableURL = java
        process.arguments = cache.jvmArguments() + [
            "-Dspring.profiles.active=desktop",
            "-Dserver.port=\(Backend.port)",   // 固定端口 —— 见类头，为了「记住登录」
            "-Dfile.encoding=UTF-8",
            // 外壳自己就是 GUI 应用，JVM 保持 headless —— 让它去连窗口服务器
            // 只会在 Dock 里多出一个图标。
            "-Djava.awt.headless=true",
            "-Dzhiqu.desktop.port-file=\(portFile.path)",
            "-Xmx1g",
            "-jar", runJar.path,
        ]
        try process.run()
    }

    /// 轮询端口文件。返回 nil 表示超时。
    ///
    /// 后端写文件用的是「临时文件 + 原子改名」，所以读到的要么是完整的端口、要么什么都没有 ——
    /// 不会读到半个数字。
    func waitForPort(timeout: TimeInterval) -> Int? {
        if attached {
            return Backend.port   // 连的是已有实例，端口就是固定那个
        }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if !process.isRunning {
                return nil  // 后端自己挂了，再等下去没有意义
            }
            if let text = try? String(contentsOf: portFile, encoding: .utf8),
               let port = Int(text.trimmingCharacters(in: .whitespacesAndNewlines)),
               port > 0 {
                return port
            }
            Thread.sleep(forTimeInterval: 0.1)
        }
        return nil
    }

    func stop() {
        try? FileManager.default.removeItem(at: portFile)
        // attached 时那个后端不是我们拉起的（另一个实例的），不能替它收尸。
        if attached { return }
        guard process.isRunning else { return }
        process.terminate()
        // 给 Spring 一点时间收尾（关连接池、flush 掉还在流式输出的消息）。
        // 第一次运行还要把应用类归档写出来（实测约 3 秒），多等一会儿 —— 只有这一次
        let training = cds?.training ?? false
        let deadline = Date().addingTimeInterval(training ? 20 : 5)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        var killed = false
        if process.isRunning {
            kill(process.processIdentifier, SIGKILL)
            killed = true
            process.waitUntilExit()
        }
        // 只有它自己正常退出的，归档才算写完了；被 SIGKILL 的那份可能是半截，删掉
        cds?.finish(cleanExit: !killed)
    }
}

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

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    private let backend = Backend()
    private var window: NSWindow!
    private var webView: WKWebView!
    private var loadingLabel: NSTextField!

    func applicationDidFinishLaunching(_ notification: Notification) {
        makeWindow()
        NSApp.activate(ignoringOtherApps: true)

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            do {
                try self.backend.start()
            } catch {
                DispatchQueue.main.async { self.fail("启动后端失败：\(error.localizedDescription)") }
                return
            }
            // 60 秒：冷启动要跑 Flyway 迁移，第一次可能比平时久不少。
            guard let port = self.backend.waitForPort(timeout: 60) else {
                DispatchQueue.main.async {
                    self.fail("后端没有在 60 秒内就绪。\n请检查数据库是否可连接（~/.zhiqu/application.yml）。")
                }
                return
            }
            DispatchQueue.main.async { self.load(port: port) }
        }
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

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()   // localStorage 要持久化 —— 登录态存在那里
        // 给 User-Agent 追加应用标识。不加的话 WKWebView 发的是 Safari 式 UA，
        // 「个人中心 → 登录设备」只能把它认成浏览器：用户明明从应用登录，却显示
        // 「Safari · macOS」。前端 shortUA() 认这个标记。
        config.applicationNameForUserAgent = "ZhiquDesktop/1.0"
        webView = WKWebView(frame: frame, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.autoresizingMask = [.width, .height]
        webView.setValue(false, forKey: "drawsBackground")

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
        window.contentView = content
        window.makeKeyAndOrderFront(nil)
    }

    private func load(port: Int) {
        loadingLabel.isHidden = true
        webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/dashboard.html")!))
    }

    private func fail(_ message: String) {
        loadingLabel.stringValue = message
        loadingLabel.isHidden = false
    }

    /// 外部链接走系统浏览器，不在应用窗口里打开 —— 应用窗口是这个产品，不是一个浏览器。
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url,
           let host = url.host,
           host != "127.0.0.1" && host != "localhost" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    /// target="_blank" 也走系统浏览器（否则 WKWebView 默认什么都不做，链接看起来像坏的）。
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        backend.stop()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
