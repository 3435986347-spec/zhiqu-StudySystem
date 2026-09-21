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
    private let process = Process()
    private let portFile: URL

    /// 端口文件放在临时目录，每次启动一个新的 —— 不能复用固定路径：
    /// 上一次遗留的文件会让外壳立刻连到一个已经不存在的端口上。
    init() {
        portFile = FileManager.default.temporaryDirectory
            .appendingPathComponent("zhiqu-port-\(ProcessInfo.processInfo.processIdentifier)")
        try? FileManager.default.removeItem(at: portFile)
    }

    func start() throws {
        let resources = Bundle.main.resourceURL!
        let java = resources.appendingPathComponent("runtime/Contents/Home/bin/java")
        let jar = try FileManager.default
            .contentsOfDirectory(at: resources.appendingPathComponent("app"),
                                 includingPropertiesForKeys: nil)
            .first { $0.pathExtension == "jar" }!

        process.executableURL = java
        process.arguments = [
            "-Dspring.profiles.active=desktop",
            "-Dfile.encoding=UTF-8",
            // 外壳自己就是 GUI 应用，JVM 保持 headless —— 让它去连窗口服务器
            // 只会在 Dock 里多出一个图标。
            "-Djava.awt.headless=true",
            "-Dzhiqu.desktop.port-file=\(portFile.path)",
            "-Xmx1g",
            "-jar", jar.path,
        ]
        try process.run()
    }

    /// 轮询端口文件。返回 nil 表示超时。
    ///
    /// 后端写文件用的是「临时文件 + 原子改名」，所以读到的要么是完整的端口、要么什么都没有 ——
    /// 不会读到半个数字。
    func waitForPort(timeout: TimeInterval) -> Int? {
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
        guard process.isRunning else { return }
        process.terminate()
        // 给 Spring 一点时间收尾（关连接池、flush 掉还在流式输出的消息）。
        let deadline = Date().addingTimeInterval(5)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning {
            kill(process.processIdentifier, SIGKILL)
        }
    }
}

// MARK: - 窗口

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
