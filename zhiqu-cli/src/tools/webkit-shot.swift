// 没有 Chrome.app 时，用系统自带的 WebKit 在沙箱外截一张图（zhiqu preview_page）。
// 用法：zhiqu-webkit-shot <url> <输出.png> <宽> <高> <超时秒>
import AppKit
import WebKit

let args = CommandLine.arguments
guard args.count == 6,
      let url = URL(string: args[1]),
      let width = Int(args[3]), let height = Int(args[4]),
      let timeout = Double(args[5]), width > 0, height > 0, timeout > 0 else {
    fputs("用法: zhiqu-webkit-shot URL 输出.png 宽 高 超时秒\n", stderr)
    exit(2)
}
let out = URL(fileURLWithPath: args[2])

final class Shot: NSObject, WKNavigationDelegate {
    let web: WKWebView
    let out: URL
    var finished = false
    init(web: WKWebView, out: URL) {
        self.web = web
        self.out = out
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // 给页面自己的脚本、WebGL 第一帧一点时间
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { self.snap() }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error) }
    func snap() {
        if finished { return }
        let config = WKSnapshotConfiguration()
        config.rect = web.bounds
        web.takeSnapshot(with: config) { image, error in
            if let error { self.fail(error); return }
            guard let tiff = image?.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]), !png.isEmpty else {
                fputs("截图是空的\n", stderr)
                self.finish(3)
                return
            }
            do { try png.write(to: self.out) } catch { self.fail(error); return }
            self.finish(0)
        }
    }
    func fail(_ error: Error) {
        if finished { return }
        fputs(error.localizedDescription + "\n", stderr)
        finish(4)
    }
    func finish(_ code: Int32) {
        if finished { return }
        finished = true
        exit(code)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let frame = NSRect(x: 0, y: 0, width: width, height: height)
let web = WKWebView(frame: frame)
let window = NSWindow(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = web
window.setFrameOrigin(NSPoint(x: -32000, y: -32000))
window.orderBack(nil)
let shot = Shot(web: web, out: out)
web.navigationDelegate = shot
web.load(URLRequest(url: url))
DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
    if !shot.finished {
        fputs("渲染超时\n", stderr)
        shot.finish(5)
    }
}
app.run()
