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
//   Snapshot <token 或 @令牌文件> <输出目录> <基址> <路径1> [路径2 ...]
//   SNAP_THEME=dark Snapshot ...    浅色 / 深色各截一套（第四十六轮：首页轮播跟着页面的明暗换图）；不给就跟系统
// 例：
//   SNAP_THEME=light Snapshot @/tmp/shots.token ./out http://127.0.0.1:8080 /dashboard.html /ai-assistant.html
//   令牌用 @文件 传：直接写在命令行上，跑的这十几秒里别的进程看得见
//   SNAP_STORAGE='{"zq.c.zq-wiki-toc":"0"}'  页面打开前再往 localStorage 里写几项（展开哪几块面板），JSON 对象

import AppKit
import WebKit

let args = CommandLine.arguments
guard args.count >= 5 else {
    FileHandle.standardError.write("用法: Snapshot <token> <outDir> <baseUrl> <path>...\n".data(using: .utf8)!)
    exit(2)
}
let token: String = {
    guard args[1].hasPrefix("@") else { return args[1] }
    let file = String(args[1].dropFirst())
    guard let text = try? String(contentsOfFile: file, encoding: .utf8) else {
        FileHandle.standardError.write("读不到令牌文件 \(file)\n".data(using: .utf8)!)
        exit(2)
    }
    return text.trimmingCharacters(in: .whitespacesAndNewlines)
}()
// 页面的明暗由 localStorage 的 zq.theme 定（每页头上那行内联脚本读它）；表单控件、滚动条这些原生的东西跟窗口的外观走，一起设
let theme = ProcessInfo.processInfo.environment["SNAP_THEME"] ?? ""
let storage: String = {
    guard let raw = ProcessInfo.processInfo.environment["SNAP_STORAGE"], !raw.isEmpty else { return "" }
    guard let data = raw.data(using: .utf8),
          (try? JSONSerialization.jsonObject(with: data)) as? [String: String] != nil else {
        FileHandle.standardError.write("SNAP_STORAGE 要是一个 JSON 对象，值都是字符串\n".data(using: .utf8)!)
        exit(2)
    }
    return "var o=\(raw);for(var k in o)localStorage.setItem(k,o[k]);"
}()
guard theme.isEmpty || theme == "light" || theme == "dark" else {
    FileHandle.standardError.write("SNAP_THEME 只认 light / dark\n".data(using: .utf8)!)
    exit(2)
}
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
        let themeJs = theme.isEmpty ? "" : "localStorage.setItem('zq.theme', '\(theme)');"
        let js = "try{localStorage.setItem('token', '\(token)');\(themeJs)\(storage)}catch(e){}"
        config.userContentController.addUserScript(
            WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height),
                            configuration: config)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                          styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = webView
        if theme == "dark" { window.appearance = NSAppearance(named: .darkAqua) }
        if theme == "light" { window.appearance = NSAppearance(named: .aqua) }
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
                        .replacingOccurrences(of: ".html", with: "") + (theme.isEmpty ? "" : "-" + theme) + ".png"
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
