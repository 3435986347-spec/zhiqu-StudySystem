// 显示页面的 WKWebView，连同页面要、而 WKWebView 自己不做的那几件事。
//
// WKWebView 只是一个引擎：浏览器里理所当然的东西 —— 弹文件选择框、下载、外部链接开到别处 —— 都要宿主应用
// 自己实现代理方法，**不实现也不报错**：
//
//   - 文件选择：不实现 runOpenPanelWith，<input type="file"> 被点时 WebKit 直接当成「用户点了取消」，
//     系统面板根本不出来。2026-10-01 用户报「Wiki 导入来源 → 上传文件解析，点了没反应」；
//     AI 助手的「上传资料」、换头像走的是同一个原生 file input，一起没反应。
//   - 下载：页面的导出 / 下载原件是 <a download href="blob:…"> 。导航策略回 .allow 的话，
//     WKWebView 不下载，而是把**整个窗口导航到那个 blob** —— 应用窗口里只剩文件的原文，
//     无边框的窗口没有「后退」，只能退出重开。
//
// 两件事都是在一个真的 WKWebView 里实测出来的，DesktopPageViewTest 也是这样判的（PageView.swift 和一个检查程序
// 一起编译，真点 file input、真点 a[download]）。所以这一份不放进 ZhiquShell.swift：那边有顶层代码和后端进程，
// 检查程序没法和它一起编译。
//
// 为什么是 WKWebView 的子类、自己当自己的代理：uiDelegate / navigationDelegate 是 weak 的。
// 写成 `webView.uiDelegate = SomeHelper()` 的话，那个对象当场就被释放，一切又回到「点了没反应」，同样不报错。
// 自己当自己的代理，就不存在「谁来持有它」这个问题。

import AppKit
import WebKit

final class PageView: WKWebView, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    /// 弹文件选择面板，回调给选中的文件（nil = 取消）。检查程序换成不开面板的桩，外壳用默认的。
    var chooseFiles: (NSOpenPanel, NSWindow?, @escaping ([URL]?) -> Void) -> Void = { panel, window, done in
        if let window {
            panel.beginSheetModal(for: window) { done($0 == .OK ? panel.urls : nil) }
        } else {
            panel.begin { done($0 == .OK ? panel.urls : nil) }
        }
    }
    /// 问下载存到哪（nil = 取消）。
    var chooseSaveLocation: (NSSavePanel, NSWindow?, @escaping (URL?) -> Void) -> Void = { panel, window, done in
        if let window {
            panel.beginSheetModal(for: window) { done($0 == .OK ? panel.url : nil) }
        } else {
            panel.begin { done($0 == .OK ? panel.url : nil) }
        }
    }
    /// 外部链接交给系统浏览器。
    var openExternally: (URL) -> Void = { NSWorkspace.shared.open($0) }
    /// 下载失败时告诉用户。
    var reportFailure: (String, NSWindow?) -> Void = { message, window in
        let alert = NSAlert()
        alert.messageText = "没有保存成功"
        alert.informativeText = message
        if let window { alert.beginSheetModal(for: window) } else { alert.runModal() }
    }

    /// persistent = false 只给检查程序用：不碰真实的 localStorage（登录态存在那里）。
    init(frame: NSRect, persistent: Bool = true) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = persistent ? .default() : .nonPersistent()   // localStorage 要持久化 —— 登录态存在那里
        // 给 User-Agent 追加应用标识。不加的话 WKWebView 发的是 Safari 式 UA，
        // 「个人中心 → 登录设备」只能把它认成浏览器：用户明明从应用登录，却显示
        // 「Safari · macOS」。前端 shortUA() 认这个标记。
        config.applicationNameForUserAgent = "ZhiquDesktop/1.0"
        super.init(frame: frame, configuration: config)
        navigationDelegate = self
        uiDelegate = self
        setValue(false, forKey: "drawsBackground")
    }

    required init?(coder: NSCoder) { fatalError("PageView 只从代码里建") }

    // MARK: 文件选择

    /// <input type="file"> 被点了。completionHandler 必须恰好调一次（不调的话 WebKit 抛异常）。
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        // accept 属性（.pdf,.xlsx…）WebKit 没有公开给代理，面板里不按类型过滤；服务端照样只收它认得的类型
        chooseFiles(panel, window, completionHandler)
    }

    // MARK: 导航与下载

    /// 外部链接走系统浏览器，不在应用窗口里打开 —— 应用窗口是这个产品，不是一个浏览器。
    /// <a download> 交给下载，不导航过去。
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        if let url = navigationAction.request.url,
           let host = url.host,
           host != "127.0.0.1" && host != "localhost" {
            openExternally(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    /// 每个下载要写到哪（失败时说得出是哪儿写不进去）
    private var destinations: [ObjectIdentifier: URL] = [:]

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    /// 存到哪由用户选（页面在浏览器里也是先问位置的：showSaveFilePicker）。
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        chooseSaveLocation(panel, window) { url in
            // 面板里已经问过「替换吗」；而 WKDownload 不肯写到一个已经存在的文件上（直接失败），所以替换要先删
            if let url, FileManager.default.fileExists(atPath: url.path) {
                try? FileManager.default.removeItem(at: url)
            }
            if let url { self.destinations[ObjectIdentifier(download)] = url }
            completionHandler(url)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        destinations[ObjectIdentifier(download)] = nil
    }

    /// 写不进去（没有权限、盘满）。实测：在保存面板里点取消不会走到这里；而写不进只读目录时，
    /// WebKit 报的恰恰是「已取消」（NSURLErrorCancelled，没有说明）—— 所以不能按「取消」把它滤掉，
    /// 也不能只把 error 的说明拿给用户看（那是空的），要说出写的是哪儿。
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let place = destinations.removeValue(forKey: ObjectIdentifier(download))?.path ?? "选的位置"
        reportFailure("没能写到「\(place)」。可能是那个文件夹没有写入权限，或者磁盘满了 —— 换一个位置再试。", window)
    }

    /// target="_blank" 也走系统浏览器（否则 WKWebView 默认什么都不做，链接看起来像坏的）。
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            openExternally(url)
        }
        return nil
    }
}
