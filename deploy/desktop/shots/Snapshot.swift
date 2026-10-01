// 给首页轮播出截图的工具。
//
// 为什么不用系统的 screencapture：它要「屏幕录制」权限，而且截的是当前屏幕 ——
// 尺寸、窗口位置、有没有别的东西挡住都不可控，换台机器就出不来同一张图。
//
// 为什么不用 Chrome headless：页面有登录守卫，要先往 localStorage 里塞 token。
// 用 WKWebView 可以在 document-start 阶段注入脚本，而且它就是应用窗口用的那个引擎 ——
// 截出来的和用户在应用里看到的逐像素一致。
//
// 用法：
//   Snapshot <token> <输出目录> <基址> <路径1> [路径2 ...]
// 例：
//   Snapshot eyJ... ./out http://127.0.0.1:8080 /dashboard.html /ai.html

import AppKit
import WebKit

let args = CommandLine.arguments
guard args.count >= 5 else {
    FileHandle.standardError.write("用法: Snapshot <token> <outDir> <baseUrl> <path>...\n".data(using: .utf8)!)
    exit(2)
}
let token = args[1]
let outDir = URL(fileURLWithPath: args[2], isDirectory: true)
let baseUrl = args[3]
let paths = Array(args[4...])

let width: CGFloat = 1440
let height: CGFloat = 900

try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

final class Shooter: NSObject, WKNavigationDelegate {
    private let webView: WKWebView
    private var queue: [String]
    private var current: String?

    /// WKWebView 必须挂进一个**真正显示在屏幕上**的窗口。
    ///
    /// 这一条是试出来的，试了三次：
    ///
    ///   1. 不挂窗口 —— 截出来只有侧边栏，主内容区整个是空的（而同一页面在真浏览器里正常）
    ///   2. 挂进窗口但 orderBack —— 一模一样的空图，字节数都不变
    ///   3. 挂进窗口、放到屏幕外（y = -10000）+ orderFrontRegardless —— 还是空图
    ///   4. 窗口放在屏幕内 —— 内容全出来了（PNG 从 168KB 变成 403KB）
    ///
    /// 结论是窗口服务器只给**真正可见**的窗口分配绘制表面，takeSnapshot 读的就是那个表面；
    /// DOM 里有内容不等于它被画过。所以这个工具跑的时候会在屏幕上短暂出现一个窗口 ——
    /// 这不是疏忽，是它能工作的前提。
    ///
    /// 空图这个失败模式特别坏：它不报错，产出的 PNG 大小还很正常，
    /// 看起来就像「这一页设计得比较空」。所以下面还有一条内容就绪的轮询，
    /// 等不到内容会明确打警告。
    private let window: NSWindow

    init(token: String) {
        let config = WKWebViewConfiguration()
        // 登录守卫读 localStorage.token。document-start 注入，赶在页面脚本之前。
        let js = "try{localStorage.setItem('token', '\(token)');}catch(e){}"
        config.userContentController.addUserScript(
            WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height),
                            configuration: config)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                          styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = webView
        // orderFrontRegardless 而不是 orderBack：窗口服务器只给「在屏」的窗口分配绘制表面，
        // orderBack 的窗口 takeSnapshot 出来主内容区是空的（DOM 里有内容，只是没被画过）。
        // 窗口坐标在可见区域之外，所以用户看不到它。
        window.orderFrontRegardless()
        queue = paths
        super.init()
        webView.navigationDelegate = self
    }

    func start() { next() }

    private func next() {
        guard let path = queue.first else {
            print("全部完成")
            exit(0)
        }
        queue.removeFirst()
        current = path
        webView.load(URLRequest(url: URL(string: baseUrl + path)!))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // onload 只说明 HTML 到了，前端还要发好几个 XHR 才把数据填进去。
        // 所以轮询主内容区有没有东西，而不是死等一个固定秒数 —— 固定秒数在慢一点的机器上
        // 会截到半张图，而且它不会报错，只会给你一张看起来「设计得很空」的截图。
        waitForContent(attempt: 0)
    }

    /// 轮询 .zq-main 的文字量。够了就再缓 0.8 秒等字体和过渡动画落定。
    private func waitForContent(attempt: Int) {
        let probe = "(function(){var m=document.querySelector('.zq-main');"
            + "return m? m.innerText.trim().length : 0;})()"
        webView.evaluateJavaScript(probe) { [weak self] value, _ in
            guard let self else { return }
            let length = (value as? Int) ?? 0
            if length >= 200 || attempt >= 60 {
                if length < 200 {
                    print("  [警告] 等了 \(Double(attempt) * 0.25) 秒主内容仍只有 \(length) 个字符，"
                        + "这张图可能是空的")
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { self.capture() }
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                    self.waitForContent(attempt: attempt + 1)
                }
            }
        }
    }

    private func capture() {
        DispatchQueue.main.async { [weak self] in
            guard let self, let path = self.current else { return }
            let config = WKSnapshotConfiguration()
            config.rect = NSRect(x: 0, y: 0, width: width, height: height)
            self.webView.takeSnapshot(with: config) { image, error in
                if let image, let tiff = image.tiffRepresentation,
                   let rep = NSBitmapImageRep(data: tiff),
                   let png = rep.representation(using: .png, properties: [:]) {
                    let name = path.replacingOccurrences(of: "/", with: "")
                        .replacingOccurrences(of: ".html", with: "") + ".png"
                    let url = outDir.appendingPathComponent(name)
                    try? png.write(to: url)
                    print("  \(name)  \(png.count / 1024)KB")
                } else {
                    print("  \(path) 截图失败: \(error?.localizedDescription ?? "未知")")
                }
                self.next()
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        print("  加载失败: \(error.localizedDescription)")
        next()
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)   // 不要 Dock 图标，也不要抢焦点
let shooter = Shooter(token: token)
DispatchQueue.main.async { shooter.start() }
app.run()
