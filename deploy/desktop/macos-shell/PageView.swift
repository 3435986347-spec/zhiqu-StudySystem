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
// 一起编译，真点 file input、真点 a[download]）。所以这一份不放进 ZhiquShell.swift：那边有顶层代码，
// 检查程序没法和它一起编译。
//
// 为什么是 WKWebView 的子类、自己当自己的代理：uiDelegate / navigationDelegate 是 weak 的。
// 写成 `webView.uiDelegate = SomeHelper()` 的话，那个对象当场就被释放，一切又回到「点了没反应」，同样不报错。
// 自己当自己的代理，就不存在「谁来持有它」这个问题。

import AppKit
import UserNotifications
import WebKit

/// AppKit 的编辑快捷键从原生菜单走 responder chain；WKWebView 本身不会替宿主建立这个菜单。
func makeZhiquApplicationMenu() -> NSMenu {
    let main = NSMenu()
    let application = NSMenuItem(title: "知趣象限", action: nil, keyEquivalent: "")
    let applicationMenu = NSMenu(title: "知趣象限")
    applicationMenu.addItem(withTitle: "退出知趣象限", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    application.submenu = applicationMenu
    main.addItem(application)

    let edit = NSMenuItem(title: "编辑", action: nil, keyEquivalent: "")
    let editMenu = NSMenu(title: "编辑")
    func command(_ title: String, _ action: String, _ key: String, flags: NSEvent.ModifierFlags = .command) {
        let item = NSMenuItem(title: title, action: NSSelectorFromString(action), keyEquivalent: key)
        item.keyEquivalentModifierMask = flags
        // target 留空：Wiki 正文、AI 输入框和系统文件面板都由各自当前的 firstResponder 接收。
        editMenu.addItem(item)
    }
    command("撤销", "undo:", "z")
    command("重做", "redo:", "Z")
    editMenu.addItem(.separator())
    command("剪切", "cut:", "x")
    command("复制", "copy:", "c")
    command("粘贴", "paste:", "v")
    editMenu.addItem(.separator())
    command("全选", "selectAll:", "a")
    edit.submenu = editMenu
    main.addItem(edit)

    // 页面在服务器上了（第一百二十五轮）：断网、服务器重启时页面会打不开，要有个地方重来。target 留空：
    // 页面里有焦点时 WKWebView 接，没有时落到 AppDelegate 的 reload(_:)
    let view = NSMenuItem(title: "显示", action: nil, keyEquivalent: "")
    let viewMenu = NSMenu(title: "显示")
    viewMenu.addItem(NSMenuItem(title: "重新载入", action: NSSelectorFromString("reload:"), keyEquivalent: "r"))
    view.submenu = viewMenu
    main.addItem(view)
    return main
}

/// userContentController 强持有消息处理者，而 PageView 又持有 configuration —— 直接把自己挂上去就是循环引用，窗口关了也不释放。
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(c, didReceive: message)
    }
}

/// 带回复的那种（本机代码助手的桥要把结果回给页面）同样会被强持有
private final class WeakReplyHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var target: WKScriptMessageHandlerWithReply?
    init(_ target: WKScriptMessageHandlerWithReply) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let target else { replyHandler(nil, "窗口已经关了"); return }
        target.userContentController(c, didReceive: message, replyHandler: replyHandler)
    }
}

final class PageView: WKWebView, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler, WKScriptMessageHandlerWithReply {
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

    /// 页面要提醒用户（番茄钟到点、任务提醒到点，第二十五轮）。WKWebView 里网页的 Notification 授权一请求就是「拒绝」（实测），
    /// 所以页面在桌面应用里改走这座桥（`window.webkit.messageHandlers.zqNotify`），这里发 macOS 原生通知 —— 窗口在后台、最小化也看得到。
    /// 声音由页面自己响（WebAudio），原生通知不再带声音，免得响两遍。参数：标题、正文、标识（同一条提醒重复发只留最新的）。
    var deliverNotification: (String, String, String) -> Void = { title, body, tag in
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: tag, content: content, trigger: nil))
        if !NSApp.isActive { NSApp.requestUserAttention(.informationalRequest) }   // Dock 图标跳一下
    }
    /// 页面请求通知授权（用户点「开始」番茄钟、保存带提醒的任务时）。第一次会弹系统的授权框，之后系统记着。
    var requestNotificationAuthorization: () -> Void = {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert]) { _, _ in }
    }
    /// 迷你番茄钟（第五十一轮）：页面经 `window.webkit.messageHandlers.zqMini` 说「缩小到桌面」（shrink，看板的番茄钟卡片上）
    /// 或「展开」（expand，迷你窗的胶囊上），外壳换窗口。页面看得到这座桥才显示「缩小到桌面」—— 浏览器里没有。
    var onMini: (String) -> Void = { _ in }
    /// 这个应用自己的网站（第一百二十五轮：页面从服务器来，默认 zhiqustudy.com）：只有它的链接留在窗口里，别的交给系统浏览器；
    /// 页面经桥发来的消息也只认它的主框架。外壳按服务器地址设；检查程序在本机起页面，用默认的本机。
    /// 不是本机的只认 https（`isOwnSite`）：同一个域名的明文页面可能是半路被人换过的
    var allowedHosts: Set<String> = ["127.0.0.1", "localhost"]
    /// 主框架载入完了（nil）或者没载入成（断网、服务器在重启）：外壳据此收起「正在连接」或者说清楚
    var onLoad: (Error?) -> Void = { _ in }
    /// 本机代码助手（第一百二十九轮，LocalAgent.swift）：只有主窗口设，迷你窗没有 —— 没设的页面问 zqLocal 一律回「没有」
    var localAgent: LocalAgent?
    /// 用户在系统选框里选过的项目文件夹；检查程序换成一份单独的偏好设置
    var localFolders = LocalFolders()
    /// 弹「选文件夹」的系统框（nil = 取消）。检查程序换成不开面板的桩
    var chooseFolder: (NSOpenPanel, NSWindow?, @escaping (URL?) -> Void) -> Void = { panel, window, done in
        if let window {
            panel.beginSheetModal(for: window) { done($0 == .OK ? panel.url : nil) }
        } else {
            panel.begin { done($0 == .OK ? panel.url : nil) }
        }
    }
    private var localRunSeq = 0

    /// persistent = false 只给检查程序用：不碰真实的 localStorage（登录态存在那里）。
    /// dataStore 也只给检查程序用：两个页面共用一份不落盘的网站数据，像主窗口和迷你窗共用 .default() 那样。
    init(frame: NSRect, persistent: Bool = true, dataStore: WKWebsiteDataStore? = nil) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = dataStore ?? (persistent ? .default() : .nonPersistent())   // localStorage 要持久化 —— 登录态存在那里
        // 给 User-Agent 追加应用标识。不加的话 WKWebView 发的是 Safari 式 UA，
        // 「设置 → 账号与安全」的登录设备只能把它认成浏览器：用户明明从应用登录，却显示
        // 「Safari · macOS」。前端 shortUA() 认这个标记。
        config.applicationNameForUserAgent = "ZhiquDesktop/1.0"
        super.init(frame: frame, configuration: config)
        navigationDelegate = self
        uiDelegate = self
        config.userContentController.add(WeakMessageHandler(self), name: "zqNotify")
        config.userContentController.add(WeakMessageHandler(self), name: "zqMini")
        config.userContentController.addScriptMessageHandler(WeakReplyHandler(self), contentWorld: .page, name: "zqLocal")
        setValue(false, forKey: "drawsBackground")
    }

    required init?(coder: NSCoder) { fatalError("PageView 只从代码里建") }

    func isOwnSite(scheme: String?, host: String?) -> Bool {
        guard let host, allowedHosts.contains(host) else { return false }
        switch scheme?.lowercased() {
        case "https": return true
        case "http": return ["127.0.0.1", "localhost"].contains(host)
        default: return false   // file://localhost/… 也有主机，不是网站
        }
    }

    // MARK: 页面里的提醒 → macOS 通知

    /// 页面发来的：zqNotify 的 {action: "notify", title, body, tag} / {action: "authorize"}，zqMini 的 {action: "shrink"} / {action: "expand"}。
    /// 别的一律不理（页面内容不可信，只接这几种）。
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        // 页面在服务器上了：只认这个应用自己网站的主框架。嵌在页面里的框（AI 生成的 HTML 预览是 srcdoc 的 iframe，
        // 桥在每个框里都看得见）发的不理 —— 不然一段生成的网页就能弹通知、把主窗口缩没
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, isOwnSite(scheme: origin.protocol, host: origin.host) else { return }
        guard let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        switch (message.name, action) {
        case ("zqMini", "shrink"), ("zqMini", "expand"):
            onMini(action)
        case ("zqNotify", "authorize"):
            requestNotificationAuthorization()
        case ("zqNotify", "notify"):
            let title = String(((body["title"] as? String) ?? "知趣").prefix(80))
            let text = String(((body["body"] as? String) ?? "").prefix(240))
            let tag = String(((body["tag"] as? String) ?? title).prefix(80))
            deliverNotification(title, text, tag)
        default:
            break
        }
    }

    // MARK: 本机代码助手（第一百二十九轮）

    /// 页面经 zqLocal 问的（带回复，页面那边是 await postMessage(...)）：
    ///   {action: "status"} → {available, running, folders, network}
    ///   {action: "pick"} → 系统的选文件夹框 → {folder} / {cancelled: true}
    ///   {action: "run", folder, message, history, model, effort, level, command, token} → {runId}；之后每一行经 zq-local 事件到页面
    ///   {action: "stop"} → {stopping: true}
    ///   {action: "read", folder, path} → {content, absent}（确认框里看 diff；只读选过的文件夹里的相对路径）
    ///   {action: "apply", folder, files:[{path, content, baseline}]} → {written}（基线不符一个都不写；路径出不了选过的文件夹）
    /// 和别的桥一样只认自己网站的主框架；根目录只认选过的文件夹，服务器地址用外壳自己的（见 LocalAgent.swift 开头）
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, isOwnSite(scheme: origin.protocol, host: origin.host) else {
            replyHandler(nil, "不认这个来源")
            return
        }
        guard let agent = localAgent else { replyHandler(nil, "这个窗口没有本机代码助手"); return }
        guard let body = message.body as? [String: Any], let action = body["action"] as? String else { replyHandler(nil, "认不出的请求"); return }
        switch action {
        case "status":
            replyHandler(["available": agent.available, "running": agent.running, "folders": localFolders.all, "network": agent.config.network], nil)
        case "pick":
            let panel = NSOpenPanel()
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.canCreateDirectories = true
            panel.allowsMultipleSelection = false
            panel.prompt = "用这个文件夹"
            panel.message = "选一个项目文件夹：本机代码助手只在这里面读写、跑命令（读不到你的家目录）"
            chooseFolder(panel, window) { [weak self] url in
                guard let self, let url else { replyHandler(["cancelled": true], nil); return }
                let added = self.localFolders.add(url)
                if let path = added.path { replyHandler(["folder": path], nil) } else { replyHandler(nil, added.error ?? "这个文件夹不能用") }
            }
        case "run":
            let (parsed, problem) = LocalRunRequest.parse(body)
            guard let req = parsed else { replyHandler(nil, problem ?? "认不出的请求"); return }
            guard localFolders.contains(req.folder) else { replyHandler(nil, "这个文件夹还没在「选文件夹」里选过"); return }
            localRunSeq += 1
            let runId = "local-\(localRunSeq)"
            if let failed = agent.start(req, root: LocalFolders.real(req.folder), onMessage: { [weak self] m in self?.emitLocal(runId, m) }) {
                replyHandler(nil, failed)
            } else {
                // 页面按外壳的真实预算等待，不再另存一份 250 秒的限额。
                replyHandler(["runId": runId, "timeoutMs": agent.config.timeoutMs, "maxRounds": agent.config.maxRounds], nil)
            }
        case "stop":
            agent.stop()
            replyHandler(["stopping": true], nil)
        case "read":
            guard let folder = body["folder"] as? String, localFolders.contains(folder) else {
                replyHandler(nil, "这个文件夹还没在「选文件夹」里选过"); return
            }
            guard let path = body["path"] as? String else { replyHandler(nil, "没说读哪个文件"); return }
            let read = LocalDrafts.read(folder: folder, path: path)
            if let error = read.error { replyHandler(nil, error) } else { replyHandler(read.body ?? [:], nil) }
        case "apply":
            guard let folder = body["folder"] as? String, localFolders.contains(folder) else {
                replyHandler(nil, "这个文件夹还没在「选文件夹」里选过"); return
            }
            guard let files = body["files"] as? [[String: Any]] else { replyHandler(nil, "没有要写入的文件"); return }
            if let error = LocalDrafts.apply(folder: folder, files: files) { replyHandler(nil, error) }
            else { replyHandler(["written": files.count], nil) }
        default:
            replyHandler(nil, "认不出的请求")
        }
    }

    /// 宿主的一行交给页面：window 上一个 zq-local 事件（detail 是那一行，加上 runId）。页面已经不是自己的网站了就不给
    private func emitLocal(_ runId: String, _ message: [String: Any]) {
        guard let url, isOwnSite(scheme: url.scheme, host: url.host) else { return }
        var detail = message
        detail["runId"] = runId
        guard let data = try? JSONSerialization.data(withJSONObject: detail), let json = String(data: data, encoding: .utf8) else { return }
        evaluateJavaScript("window.dispatchEvent(new CustomEvent('zq-local', { detail: \(json) })); 0") { _, _ in }
    }

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

    /// 主框架这一次的回应是 5xx（后端在重启、没起来时 Caddy 回 502，正文是空的）：载入「成功」了，但窗口是白的
    private var mainStatus = 0

    /// 实现了这个方法就得自己管「显示不了的类型」：照样放行的话 WebKit 报「载入中断」（102），外壳会盖上「连不上」。
    /// 主框架打开的是一个文件（zip、附件）就当下载（走上面的保存面板）；框里的不理
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.canShowMIMEType {
            if navigationResponse.isForMainFrame {
                mainStatus = (navigationResponse.response as? HTTPURLResponse)?.statusCode ?? 0
            }
            decisionHandler(.allow)
        } else {
            decisionHandler(navigationResponse.isForMainFrame ? .download : .cancel)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if mainStatus >= 500 {
            onLoad(NSError(domain: "ZhiquServer", code: mainStatus,
                           userInfo: [NSLocalizedDescriptionKey: "服务器暂时没响应（HTTP \(mainStatus)），可能在重启"]))
        } else {
            onLoad(nil)
        }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { reportLoad(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { reportLoad(error) }
    /// 不算没载入成的两种：被新的导航顶掉的那一次（-999）；转成下载的那一次（WebKit 报「因策略改变中断」，102 —— 是这里自己选的）
    private func reportLoad(_ error: Error) {
        let e = error as NSError
        if e.code == NSURLErrorCancelled { return }
        if e.domain == "WebKitErrorDomain" && e.code == 102 { return }
        onLoad(error)
    }

    /// 外部链接走系统浏览器，不在应用窗口里打开 —— 应用窗口是这个产品，不是一个浏览器。
    /// <a download> 交给下载，不导航过去。
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        if let url = navigationAction.request.url, url.host != nil, !isOwnSite(scheme: url.scheme, host: url.host) {
            // 嵌在页面里的框自己跳走（生成的网页里一句 location.href）：不是人点的，不叫系统浏览器，就地拦下
            if navigationAction.targetFrame?.isMainFrame == false && navigationAction.navigationType != .linkActivated {
                decisionHandler(.cancel)
                return
            }
            openOutside(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    /// 交给系统的只有网页和邮件：file:// 会在 Finder 里打开（.app 就是运行它），别的协议会叫起别的应用。
    /// 页面从服务器来、里面有 AI 写的和导入的内容，链接不能都信
    private func openOutside(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme) else { return }
        openExternally(url)
    }

    /// 每个下载要写到哪（失败时说得出是哪儿写不进去）
    private var destinations: [ObjectIdentifier: URL] = [:]
    /// 用户在保存面板里取消的那几个。页面上 a[download] 的下载取消了不会走到 didFailWithError；打开一个文件转成的下载
    /// （第一百二十五轮）取消了会走到 —— 不记下来的话，用户点了「取消」反倒看到「没有保存成功」
    private var declined: Set<ObjectIdentifier> = []

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
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
            if let url { self.destinations[ObjectIdentifier(download)] = url } else { self.declined.insert(ObjectIdentifier(download)) }
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
        if declined.remove(ObjectIdentifier(download)) != nil { return }
        let place = destinations.removeValue(forKey: ObjectIdentifier(download))?.path ?? "选的位置"
        reportFailure("没能写到「\(place)」。可能是那个文件夹没有写入权限，或者磁盘满了 —— 换一个位置再试。", window)
    }

    /// target="_blank" 也走系统浏览器（否则 WKWebView 默认什么都不做，链接看起来像坏的）。
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            openOutside(url)
        }
        return nil
    }
}

/// 清掉这份网站数据里的 Service Worker 和它的缓存（第一百二十六轮）。
///
/// 页面在浏览器里装 Service Worker 是为了网络慢 / 断网时还能打开壳；桌面应用里它反倒挡事：服务器停了、断网了，
/// 它拿缓存的页面顶上，WebKit 当成载入成功（didFinish、200），外壳就不说「连不上」—— 用户看到一个点什么都没反应的旧页面
/// （用户在真窗口里停了验证站、按 ⌘R 照出来的）。页面在桌面里已经不装了（zhiqu-api.js 的 maintainShellCache），
/// 这里清掉以前装上的。只清这两样：登录态在 localStorage 里，不能动。
func clearOfflineCache(_ store: WKWebsiteDataStore, then done: @escaping () -> Void) {
    let kinds: Set<String> = [WKWebsiteDataTypeServiceWorkerRegistrations, WKWebsiteDataTypeFetchCache]
    store.removeData(ofTypes: kinds, modifiedSince: .distantPast) { DispatchQueue.main.async(execute: done) }
}
