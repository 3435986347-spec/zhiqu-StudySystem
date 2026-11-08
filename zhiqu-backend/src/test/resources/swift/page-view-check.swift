// DesktopPageViewTest 的检查程序：和 deploy/desktop/macos-shell/PageView.swift 一起编译（本文件改名成 main.swift），
// 在一个真的 WKWebView 里真点 file input、真点 a[download]、真走外部链接 —— 面板换成不开窗口的桩，其余全是真的。
// 每一步打印一行「键=值」，由 Java 那边断言。用法：check <临时目录>
import AppKit
import Network
import WebKit

let tmp = URL(fileURLWithPath: CommandLine.arguments[1])
let fm = FileManager.default
let fileA = tmp.appendingPathComponent("笔记 A.txt")
let fileB = tmp.appendingPathComponent("b.md")
try! "内容甲".write(to: fileA, atomically: true, encoding: .utf8)
try! "# 乙".write(to: fileB, atomically: true, encoding: .utf8)

func out(_ key: String, _ value: Any) { print("\(key)=\(value)"); fflush(stdout) }

/// 页面发回来的消息
final class Inbox: NSObject, WKScriptMessageHandler {
    var messages: [String] = []
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        messages.append("\(m.body)")
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let inbox = Inbox()
let web = PageView(frame: NSRect(x: 0, y: 0, width: 800, height: 600), persistent: false)
web.configuration.userContentController.add(inbox, name: "t")
// 只有 responder chain，不显示窗口、不把检查程序切到前台，也不启动用户的应用。
let editWindow = NSWindow(contentRect: web.frame, styleMask: [.titled], backing: .buffered, defer: false)
editWindow.contentView = web
editWindow.makeFirstResponder(web)
let applicationMenu = makeZhiquApplicationMenu()
let nativeEditItems = applicationMenu.items.flatMap { $0.submenu?.items ?? [] }.filter { $0.action != nil && $0.keyEquivalent != "q" }
// 安装到 NSApp 后 AppKit 会根据 responder chain 更新菜单状态 / target；先验证构造时没有写死 target。
let menuUsesResponderChain = !nativeEditItems.isEmpty && nativeEditItems.allSatisfy { $0.target == nil }
// 「显示 → 重新载入」（第一百二十五轮）：页面在服务器上，断网、服务器重启后要有个地方重来
out("menu.reload", nativeEditItems.contains { $0.action == NSSelectorFromString("reload:") && $0.keyEquivalent == "r" && $0.target == nil })
app.mainMenu = applicationMenu

// 面板的桩：记下面板怎么配的，按 nextFiles / nextSave 回答
var nextFiles: [URL]? = nil
var nextSave: URL? = nil
var lastOpenPanelMultiple: Bool? = nil
var opened: [URL] = []
var failures: [String] = []
web.chooseFiles = { panel, _, done in
    lastOpenPanelMultiple = panel.allowsMultipleSelection
    out("panel.canChooseFiles", panel.canChooseFiles)
    done(nextFiles)
}
var lastSuggested = ""
web.chooseSaveLocation = { panel, _, done in
    lastSuggested = panel.nameFieldStringValue
    done(nextSave)
}
web.openExternally = { opened.append($0) }
// 页面里的提醒 → 原生通知的桥（第二十五轮）：真的通知中心在检查程序里用不了（没有应用包），换成记下来
var delivered: [String] = []
var authorizeCalls = 0
web.deliverNotification = { title, body, tag in delivered.append(title + "|" + body + "|" + tag) }
web.requestNotificationAuthorization = { authorizeCalls += 1 }
web.reportFailure = { message, _ in failures.append(message) }
// 迷你番茄钟的桥（第五十一轮）：外壳换窗口的回调，换成记下来
var miniActions: [String] = []
web.onMini = { miniActions.append($0) }

let html = """
<html><body><input id=one type=file><input id=many type=file multiple>
<div id=native-editor contenteditable=true>原始正文甲乙</div><textarea id=native-textarea>输入框正文丙丁</textarea><script>
function say(x){ window.webkit.messageHandlers.t.postMessage(String(x)); }
function watch(id){
  var el = document.getElementById(id);
  el.addEventListener('change', function(){
    var names = Array.prototype.map.call(el.files, function(f){ return f.name; }).join('|');
    var r = new FileReader();
    r.onload = function(){ say(id + ':change:' + el.files.length + ':' + names + ':' + r.result); };
    r.readAsText(el.files[0]);
  });
  el.addEventListener('cancel', function(){ say(id + ':cancel'); });
}
watch('one'); watch('many');
function download(name, text){
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], {type: 'application/octet-stream'})); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
}
say('ready');
</script></body></html>
"""
let origin = "http://127.0.0.1:47615/"
web.loadHTMLString(html, baseURL: URL(string: origin))

// 一步一步来：每一步做一件事，等到条件成立（或超时）再下一步
var steps: [(String, () -> Void, () -> Bool)] = []
func step(_ name: String, _ action: @escaping () -> Void, until: @escaping () -> Bool) { steps.append((name, action, until)) }
func js(_ s: String) { web.evaluateJavaScript(s) { _, e in if let e { out("jsError", e.localizedDescription) } } }
func has(_ prefix: String) -> Bool { inbox.messages.contains { $0.hasPrefix(prefix) } }
func message(_ prefix: String) -> String { inbox.messages.first { $0.hasPrefix(prefix) } ?? "none" }
func content(_ url: URL) -> String { (try? String(contentsOf: url, encoding: .utf8)) ?? "" }
var location = ""
func readLocation() { web.evaluateJavaScript("location.href") { r, _ in location = (r as? String) ?? "" } }

step("load", {}, until: { has("ready") })

// 1. 单选：面板出来（不是直接当成取消），选中的真文件到了页面上、读得出内容
step("one", { nextFiles = [fileA]; js("document.getElementById('one').click()") }, until: { has("one:") })
step("one.report", {
    out("one.multiple", lastOpenPanelMultiple.map { "\($0)" } ?? "panel-not-shown")
    out("one.result", message("one:"))
}, until: { true })

// 2. 多选：面板允许多选，两份都到
step("many", { nextFiles = [fileA, fileB]; js("document.getElementById('many').click()") }, until: { has("many:") })
step("many.report", {
    out("many.multiple", lastOpenPanelMultiple.map { "\($0)" } ?? "panel-not-shown")
    out("many.result", message("many:"))
}, until: { true })

// 3. 用户在面板里点取消：页面收到 cancel，不崩
step("cancel", { inbox.messages.removeAll(); nextFiles = nil; js("document.getElementById('one').click()") }, until: { has("one:") })
step("cancel.report", { out("cancel.result", message("one:")) }, until: { true })

// 4. blob 下载：存到选的位置，窗口不导航到 blob
let dest = tmp.appendingPathComponent("导出.zip")
step("download", { nextSave = dest; js("download('知识库.zip', 'hello-zhiqu')") }, until: { content(dest) == "hello-zhiqu" })
step("download.loc", { readLocation() }, until: { !location.isEmpty })
step("download.report", {
    out("download.saved", content(dest) == "hello-zhiqu")
    out("download.suggested", lastSuggested)
    out("download.stayed", location == origin)
}, until: { true })

// 5. 存到一个已经存在的文件上（面板里确认了替换）：换成新内容，不是失败
step("replace", { nextSave = dest; js("download('知识库.zip', 'second')") }, until: { content(dest) == "second" || !failures.isEmpty })
step("replace.report", { out("replace.saved", content(dest) == "second"); out("replace.failures", failures.count) }, until: { true })

// 6. 在保存面板里取消：什么都不写、不报失败、窗口还在原处
func listing() -> [String] { ((try? fm.contentsOfDirectory(atPath: tmp.path)) ?? []).sorted() }
var before: [String] = []
var waited = Date()
step("saveCancel", { nextSave = nil; before = listing(); waited = Date(); js("download('x.txt', 'nope')") },
     until: { Date().timeIntervalSince(waited) > 1.0 })
step("saveCancel.loc", { location = ""; readLocation() }, until: { !location.isEmpty })
step("saveCancel.report", {
    out("saveCancel.nothingWritten", listing() == before)
    out("saveCancel.failures", failures.count)
    out("saveCancel.stayed", location == origin)
}, until: { true })

// 7. 真的写不进去（只读的文件夹）：告诉用户写的是哪儿。实测 WebKit 这时报的是「已取消」、说明为空
let readOnly = tmp.appendingPathComponent("只读")
try! fm.createDirectory(at: readOnly, withIntermediateDirectories: true)
try! fm.setAttributes([.posixPermissions: 0o555], ofItemAtPath: readOnly.path)
step("writeFail", { nextSave = readOnly.appendingPathComponent("x.txt"); js("download('x.txt', 'nope')") },
     until: { !failures.isEmpty })
step("writeFail.report", {
    try? fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: readOnly.path)   // 临时目录要删得掉
    out("writeFail.reported", failures.count)
    out("writeFail.namesPlace", failures.first?.contains(readOnly.appendingPathComponent("x.txt").path) ?? false)
}, until: { true })

// 8. 页面经桥发通知 / 要授权；认不出的消息一律不理；太长的截断
step("bridge", {
    js("""
      const b = window.webkit.messageHandlers.zqNotify;
      b.postMessage({action: 'authorize'});
      b.postMessage({action: 'notify', title: '任务提醒', body: '发周报', tag: 'zq-reminder-7'});
      b.postMessage({action: 'notify', title: '专注结束', body: '休息一下'});
      b.postMessage({action: 'rm -rf'});
      b.postMessage('just a string');
      b.postMessage({action: 'notify', title: 'x'.repeat(500), body: 'y'.repeat(2000), tag: 't'});
    """)
}, until: { delivered.count >= 3 })
step("bridge.report", {
    out("bridge.authorize", authorizeCalls)
    out("bridge.first", delivered.first ?? "none")
    out("bridge.defaultTag", delivered.count > 1 ? delivered[1] : "none")
    out("bridge.count", delivered.count)
    out("bridge.capped", delivered.count > 2 ? delivered[2].count : 0)
}, until: { true })

// 9. 外部链接：交给系统浏览器，窗口不走
step("external", { js("location.href = 'https://example.com/x'") }, until: { !opened.isEmpty })
step("external.loc", { location = ""; readLocation() }, until: { !location.isEmpty })
step("external.report", {
    out("external.opened", opened.first?.absoluteString ?? "none")
    out("external.stayed", location == origin)
}, until: { true })

// 10. 迷你番茄钟的桥：只认 shrink / expand，交给外壳；别的（错的 action、不是对象、通知那一套）不理，也不串到通知那边
step("mini", {
    js("""
      const m = window.webkit.messageHandlers.zqMini;
      m.postMessage({action: 'shrink'});
      m.postMessage({action: 'quit'});
      m.postMessage('expand');
      m.postMessage({action: 'notify', title: '不该发', body: 'x'});
      m.postMessage({action: 'expand'});
    """)
}, until: { miniActions.count >= 2 })
step("mini.report", {
    out("mini.actions", miniActions.joined(separator: ","))
    out("mini.noNotify", !delivered.contains { $0.hasPrefix("不该发") })
}, until: { true })

// 11. 主窗口和迷你窗是两个 PageView、共用一份网站数据（外壳里都是 .default()）：一边写 localStorage，另一边读得到 ——
//     迷你窗和主窗口看同一个钟，靠的就是这一条。浏览器的锁两边是不是同一把（到点只响一次靠它）。
//     storage 事件实测不在两个 WKWebView 之间传（2026-10-09，放进窗口里也不传）：只记下来，页面靠一秒一跳和 visibilitychange
let shared = WKWebsiteDataStore.nonPersistent()
let inboxA = Inbox(), inboxB = Inbox()
let pageA = PageView(frame: NSRect(x: 0, y: 0, width: 300, height: 68), persistent: false, dataStore: shared)
let pageB = PageView(frame: NSRect(x: 0, y: 0, width: 300, height: 68), persistent: false, dataStore: shared)
pageA.configuration.userContentController.add(inboxA, name: "t")
pageB.configuration.userContentController.add(inboxB, name: "t")
let twin = """
<html><body><script>
function say(x){ window.webkit.messageHandlers.t.postMessage(String(x)); }
window.addEventListener('storage', function(e){ say('storage:' + e.key + '=' + e.newValue); });
say('ready');
</script></body></html>
"""
step("twin.load", { pageA.loadHTMLString(twin, baseURL: URL(string: origin)); pageB.loadHTMLString(twin, baseURL: URL(string: origin)) },
     until: { inboxA.messages.contains("ready") && inboxB.messages.contains("ready") })
var wroteAt = Date()
step("twin.write", { wroteAt = Date(); pageA.evaluateJavaScript("localStorage.setItem('zq.pomo.1', 'running')") { _, _ in } },
     until: { inboxB.messages.contains { $0.hasPrefix("storage:") } || Date().timeIntervalSince(wroteAt) > 1.5 })
var twinRead = ""
step("twin.read", { pageB.evaluateJavaScript("localStorage.getItem('zq.pomo.1')") { r, _ in twinRead = (r as? String) ?? "null" } },
     until: { !twinRead.isEmpty })
step("twin.lock", {
    pageA.evaluateJavaScript("navigator.locks.request('zq-pomodoro', () => new Promise(r => setTimeout(r, 3000))); 1") { _, _ in }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
        pageB.evaluateJavaScript("navigator.locks.request('zq-pomodoro', {ifAvailable: true}, l => { say('lock:' + (l ? 'free' : 'held')); }); 1") { _, _ in }
    }
}, until: { inboxB.messages.contains { $0.hasPrefix("lock:") } })
step("twin.report", {
    out("twin.event", inboxB.messages.first { $0.hasPrefix("storage:") } ?? "none")
    out("twin.read", twinRead)
    out("twin.lock", inboxB.messages.first { $0.hasPrefix("lock:") } ?? "none")
}, until: { true })

// 12. 悬浮面板的设定（MiniPanel.swift）：建出来核对，不放到屏幕上
step("panel", {
    let page = PageView(frame: NSRect(origin: .zero, size: miniPanelSize), persistent: false)
    let panel = makeMiniPanel(page: page)
    out("panel.visible", panel.isVisible)
    out("panel.floating", panel.level == .floating)
    out("panel.nonactivating", panel.styleMask.contains(.nonactivatingPanel))
    out("panel.borderless", !panel.styleMask.contains(.titled))
    out("panel.allSpaces", panel.collectionBehavior.contains(.canJoinAllSpaces) && panel.collectionBehavior.contains(.fullScreenAuxiliary))
    out("panel.clear", !panel.isOpaque && panel.backgroundColor.alphaComponent == 0 && !panel.hasShadow)
    out("panel.staysWhenInactive", !panel.hidesOnDeactivate)
    out("panel.canBecomeKey", panel.canBecomeKey)
    out("panel.size", "\(Int(panel.frame.width))x\(Int(panel.frame.height))")
    out("panel.autosave", panel.frameAutosaveName)
    let content = panel.contentView!
    let middle = content.hitTest(NSPoint(x: 150, y: 34))
    let goButton = content.hitTest(NSPoint(x: 35, y: 34))
    let expand = content.hitTest(NSPoint(x: miniPanelSize.width - 31, y: 34))
    // 不靠 mouseDownCanMoveWindow（无边框、不激活的面板上 AppKit 根本不拖，2026-10-23 真鼠标复现）：自己接 mouseDown → performDrag，第一下也收
    out("panel.dragMiddle", middle is MiniDragZone && !(middle?.mouseDownCanMoveWindow ?? true) && (middle?.acceptsFirstMouse(for: nil) ?? false))
    out("panel.buttonsClickable", !(goButton is MiniDragZone) && (goButton?.isDescendant(of: page) ?? false)
        && !(expand is MiniDragZone) && (expand?.isDescendant(of: page) ?? false))
    UserDefaults.standard.removeObject(forKey: "NSWindow Frame " + miniPanelAutosaveName)   // 检查程序不留下记住的位置
}, until: { true })

// 14. 页面从服务器来（第一百二十五轮）：只认自己网站（allowedHosts、不是本机就要 https）的链接和主框架发的消息；
//     嵌在页面里的框（AI 生成的 HTML 预览是 sandbox 的 srcdoc iframe）发的消息不理、自己跳走不叫系统浏览器；
//     交给系统的只有 http / https / mailto；主框架载入完了、5xx、连不上都告诉外壳
var served: [String] = []
let listener = try! NWListener(using: .tcp, on: .any)
listener.newConnectionHandler = { conn in
    conn.start(queue: .main)
    conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, _, _ in
        let head = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        let path = head.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
        served.append(path)
        let bad = path.hasPrefix("/bad")   // 后端在重启时 Caddy 回的就是正文为空的 502
        let file = path.hasPrefix("/file")   // 一个显示不了的文件（导出的 zip）
        let body = bad ? "" : (file ? "PK-not-really-a-zip" : "<html><body>ok</body></html>")
        let reply = "HTTP/1.1 \(bad ? "502 Bad Gateway" : "200 OK")\r\nContent-Type: \(file ? "application/zip" : "text/html")\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
        // /slow 晚一点回：在它回来之前就换了一页，这一次是被顶掉的（-999），不算没载入成
        DispatchQueue.main.asyncAfter(deadline: .now() + (path.hasPrefix("/slow") ? 1.5 : 0)) {
            conn.send(content: reply.data(using: .utf8), completion: .contentProcessed { _ in conn.cancel() })
        }
    }
}
listener.start(queue: .main)
let site = PageView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), persistent: false)
site.allowedHosts = ["zhiqu.test", "localhost"]
site.configuration.preferences.javaScriptCanOpenWindowsAutomatically = true   // 只在检查程序里：不点也能 window.open，验 target=_blank 的那条路
let siteInbox = Inbox()
site.configuration.userContentController.add(siteInbox, name: "t")
var siteOpened: [String] = []
var siteBridge: [String] = []
var siteLoads: [String] = []
site.openExternally = { siteOpened.append($0.absoluteString) }
site.deliverNotification = { title, _, _ in siteBridge.append(title) }
site.requestNotificationAuthorization = { siteBridge.append("authorize") }
site.onMini = { siteBridge.append("mini:" + $0) }
var siteSaves: [String] = []
site.chooseSaveLocation = { panel, _, done in siteSaves.append(panel.nameFieldStringValue); done(nil) }
// 失败提示也换成桩：默认的是系统的提示框（runModal），检查程序不许在用户的屏幕上弹任何东西（第一百二十五轮扰动时真弹出来过）
var siteFailures: [String] = []
site.reportFailure = { message, _ in siteFailures.append(message) }
site.onLoad = { error in
    siteLoads.append(error.map { "error:\(($0 as NSError).domain):\(($0 as NSError).code)" } ?? "ok")
}
func siteJs(_ s: String) { site.evaluateJavaScript(s + "; 0") { _, e in if let e { out("siteJsError", e.localizedDescription) } } }
let sitePage = """
<html><body><iframe sandbox="allow-scripts allow-same-origin" srcdoc="<script>
  window.webkit.messageHandlers.zqNotify.postMessage({action: 'notify', title: '同源的框里发的'});
  window.webkit.messageHandlers.t.postMessage('same-origin-frame-posted');
</script>"></iframe><iframe sandbox="allow-scripts" srcdoc="<script>
  window.webkit.messageHandlers.zqNotify.postMessage({action: 'notify', title: '框里发的'});
  window.webkit.messageHandlers.zqNotify.postMessage({action: 'authorize'});
  window.webkit.messageHandlers.zqMini.postMessage({action: 'shrink'});
  window.webkit.messageHandlers.t.postMessage('frame-posted');
  location.href = 'https://example.com/frame';
</script>"></iframe><script>
window.webkit.messageHandlers.t.postMessage('ready');
</script></body></html>
"""
step("site.load", { site.loadHTMLString(sitePage, baseURL: URL(string: "https://zhiqu.test/")) },
     until: { siteInbox.messages.contains("ready") && siteInbox.messages.contains("frame-posted")
              && siteInbox.messages.contains("same-origin-frame-posted") && !siteLoads.isEmpty })
step("site.main", { siteJs("window.webkit.messageHandlers.zqNotify.postMessage({action: 'notify', title: '主框架发的'})") },
     until: { siteBridge.contains("主框架发的") })
var settleFrom = Date()
step("site.settle", { settleFrom = Date() }, until: { Date().timeIntervalSince(settleFrom) > 0.8 })
step("site.report", {
    out("site.firstLoad", siteLoads.first ?? "none")
    out("site.framePosted", siteInbox.messages.contains("frame-posted") && siteInbox.messages.contains("same-origin-frame-posted"))
    out("site.bridge", siteBridge.joined(separator: ","))
    out("site.frameStayed", !siteOpened.contains { $0.contains("example.com/frame") })
}, until: { true })
// 同一个主机的明文页面、不在名单里的本机、file:// 都不是自己的网站；file:// 也不交给系统（.app 会被运行）
step("site.links", {
    siteOpened.removeAll()
    siteJs("location.href = 'http://zhiqu.test/plain'")
}, until: { siteOpened.contains("http://zhiqu.test/plain") })
step("site.loopback", { siteJs("location.href = 'http://127.0.0.1:47615/x'") }, until: { siteOpened.contains("http://127.0.0.1:47615/x") })
step("site.file", {
    siteJs("location.href = 'file://example.com/Applications/Calculator.app'")
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { siteJs("location.href = 'https://example.com/after-file'") }
}, until: { siteOpened.contains("https://example.com/after-file") })
step("site.blank", {
    siteJs("window.open('file://example.com/Applications/Calculator.app', '_blank'); window.open('mailto:a@zhiqu.test', '_blank'); window.open('https://example.com/blank', '_blank')")
}, until: { siteOpened.contains("https://example.com/blank") })
step("site.links.report", { out("site.opened", siteOpened.joined(separator: ",")) }, until: { true })
// 自己网站里的链接留在窗口里：真去本机的小服务器取一页（200 → 载入完了；502 → 当成没载入成；连不上 → 说出来）
step("site.listener", {}, until: { listener.port != nil })
step("site.ok", {
    siteLoads.removeAll(); siteOpened.removeAll()
    siteJs("location.href = 'http://localhost:\(listener.port!.rawValue)/ok'")
}, until: { !siteLoads.isEmpty })
step("site.ok.report", {
    out("site.ok", siteLoads.joined(separator: ","))
    out("site.ok.served", served.contains("/ok"))
    out("site.ok.inside", siteOpened.isEmpty)
}, until: { true })
step("site.slow", {
    siteLoads.removeAll()
    siteJs("location.href = 'http://localhost:\(listener.port!.rawValue)/slow'")
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { siteJs("location.href = 'http://localhost:\(listener.port!.rawValue)/ok?again'") }
}, until: { siteLoads.contains("ok") })
var slowFrom = Date()
step("site.slow.settle", { slowFrom = Date() }, until: { Date().timeIntervalSince(slowFrom) > 1.6 })
step("site.slow.report", { out("site.slow", siteLoads.joined(separator: ",")) }, until: { true })
// 页面不是名单里的网站（比如半路被换成了别处的页面）：主框架发的也不理；换回名单里的照常收（对照）
step("site.foreign", {
    siteBridge.removeAll()
    site.allowedHosts = ["zhiqu.test"]
    siteJs("window.webkit.messageHandlers.zqNotify.postMessage({action: 'notify', title: '名单外的主框架'})")
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
        site.allowedHosts = ["zhiqu.test", "localhost"]
        siteJs("window.webkit.messageHandlers.zqNotify.postMessage({action: 'notify', title: '名单里的主框架'})")
    }
}, until: { siteBridge.contains("名单里的主框架") })
step("site.foreign.report", { out("site.foreign", siteBridge.joined(separator: ",")) }, until: { true })
// 主框架打开的是一个文件：当下载（问存到哪），不是「载入中断」；框里打开的不理（不弹保存面板）
var frameFileFrom = Date()
step("site.file.frame", {
    frameFileFrom = Date()
    siteJs("document.body.appendChild(Object.assign(document.createElement('iframe'), {src: '/file/框里的.zip'}))")
}, until: { Date().timeIntervalSince(frameFileFrom) > 1.0 })
step("site.file.download", {
    siteLoads.removeAll()
    siteJs("location.href = 'http://localhost:\(listener.port!.rawValue)/file/知识库.zip'")
}, until: { !siteSaves.isEmpty })
var fileFrom = Date()
step("site.file.settle", { fileFrom = Date() }, until: { Date().timeIntervalSince(fileFrom) > 0.5 })
step("site.file.report", {
    out("site.file.saves", siteSaves.joined(separator: ","))
    out("site.file.loads", siteLoads.joined(separator: ","))
    out("site.file.served", served.filter { $0.hasPrefix("/file/") }.count)
    out("site.file.failures", siteFailures.count)   // 在保存面板里取消（这里一律回 nil）不算失败   // 框里那一个也真的取了：不然「框里的不理」什么都没验
}, until: { true })
step("site.bad", { siteLoads.removeAll(); siteJs("location.href = 'http://localhost:\(listener.port!.rawValue)/bad'") }, until: { !siteLoads.isEmpty })
step("site.bad.report", { out("site.bad", siteLoads.joined(separator: ",")) }, until: { true })
// 连不上：把小服务器关掉再去同一个端口（不用 1 这类端口 —— WebKit 自己拦着那些「受限端口」，根本不发请求）
var closedPort: UInt16 = 0
var closedAt = Date()
step("site.close", { closedPort = listener.port!.rawValue; listener.cancel(); closedAt = Date() }, until: { Date().timeIntervalSince(closedAt) > 0.3 })
step("site.down", { siteLoads.removeAll(); siteJs("location.href = 'http://localhost:\(closedPort)/down'") }, until: { !siteLoads.isEmpty })
step("site.down.report", { out("site.down", siteLoads.joined(separator: ",")) }, until: { true })

// 14b. 断网时 Service Worker 拿缓存顶上（第一百二十六轮，用户在真窗口里停了验证站、按 ⌘R 照出来的）：
//      WebKit 当成载入成功，外壳就不说「连不上」。照外壳的启动走：页面撤掉（应用退出）→ clearOfflineCache → 新页面打开。
//      对照组：同样装上、不清 —— 必须是「载入成功」，不然这一段什么都没验（可能 Service Worker 根本没装上）。
//      每组一份不落盘的网站数据、一个本机小服务器（Service Worker 要安全来源：localhost 的 http 算）。
//      同一个进程里 WebKit 的 Service Worker 进程还活着，清了以后报的是 WebKitServiceWorker 的错，真应用重开时是 -1004；
//      对外壳来说要的是同一件事：没载入成（Java 那边只认「是个错误」）
final class SwSite {
    let listener = try! NWListener(using: .tcp, on: .any)
    var served: [String] = []
    init() {
        listener.newConnectionHandler = { [weak self] conn in
            conn.start(queue: .main)
            conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, _, _ in
                let head = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                let path = head.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
                self?.served.append(path)
                let worker = path.hasPrefix("/sw.js")
                // 和发布的 service-worker.js 同一个形状：先去网络，取不到拿缓存
                let body = worker
                    ? "self.addEventListener('install', e => { e.waitUntil(caches.open('c').then(c => c.add('/page')).then(() => self.skipWaiting())) });"
                      + "self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()) });"
                      + "self.addEventListener('fetch', e => { e.respondWith(fetch(e.request).catch(() => caches.match(e.request, {ignoreSearch: true}))) });"
                    : "<html><body>page<script>navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(() => window.webkit.messageHandlers.t.postMessage('sw-ready'))</script></body></html>"
                let reply = "HTTP/1.1 200 OK\r\nContent-Type: \(worker ? "text/javascript" : "text/html")\r\nCache-Control: no-store\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
                conn.send(content: reply.data(using: .utf8), completion: .contentProcessed { _ in conn.cancel() })
            }
        }
        listener.start(queue: .main)
    }
}
func swPage(_ store: WKWebsiteDataStore, _ inbox: Inbox, _ loads: @escaping (String) -> Void) -> PageView {
    let page = PageView(frame: NSRect(x: 0, y: 0, width: 300, height: 200), persistent: false, dataStore: store)
    page.allowedHosts = ["localhost"]
    page.configuration.userContentController.add(inbox, name: "t")
    page.reportFailure = { _, _ in }   // 桩：不许在用户屏幕上弹提示框
    page.openExternally = { _ in }
    page.onLoad = { error in loads(error.map { "error:\(($0 as NSError).domain):\(($0 as NSError).code)" } ?? "ok") }
    return page
}
final class SwGroup {
    let name: String, clear: Bool
    let site = SwSite(), store = WKWebsiteDataStore.nonPersistent(), inbox = Inbox()
    var page: PageView?
    var loads: [String] = []
    var port: UInt16 = 0
    init(_ name: String, clear: Bool) { self.name = name; self.clear = clear }
}
for g in [SwGroup("sw.kept", clear: false), SwGroup("sw.cleared", clear: true)] {
    g.page = swPage(g.store, g.inbox) { g.loads.append($0) }
    step("\(g.name).listener", {}, until: { g.site.listener.port != nil })
    step("\(g.name).install", {
        g.port = g.site.listener.port!.rawValue
        g.page!.load(URLRequest(url: URL(string: "http://localhost:\(g.port)/page")!))
    }, until: { g.inbox.messages.contains("sw-ready") })
    // 再载入一次：这一次由装好的 Service Worker 经手（第一次载入时它还没接管）
    step("\(g.name).controlled", { g.loads.removeAll(); g.page!.reload() }, until: { !g.loads.isEmpty })
    var downAt = Date()
    step("\(g.name).down", { g.site.listener.cancel(); downAt = Date() }, until: { Date().timeIntervalSince(downAt) > 0.3 })
    // 应用退出：页面没了。重开：清（清的那一组）完了才建页面、打开 —— 和 ZhiquShell 的 applicationDidFinishLaunching 一样
    var cleared = false
    step("\(g.name).relaunch", {
        g.page?.removeFromSuperview()
        g.page = nil
        if g.clear { clearOfflineCache(g.store) { cleared = true } } else { cleared = true }
    }, until: { cleared })
    step("\(g.name).reopen", {
        g.page = swPage(g.store, g.inbox) { g.loads.append($0) }
        g.loads.removeAll()
        g.page!.load(URLRequest(url: URL(string: "http://localhost:\(g.port)/page")!))
    }, until: { !g.loads.isEmpty })
    step("\(g.name).report", {
        out("\(g.name).installed", g.inbox.messages.contains("sw-ready"))
        out("\(g.name).workerServed", g.site.served.contains("/sw.js"))
        out("\(g.name).offline", g.loads.joined(separator: ","))
    }, until: { true })
}

// 15. 服务器地址（Server.swift）：https 的任何主机、本机的 http；只要协议 + 主机 + 端口，主机名小写
step("server", {
    let cases: [(String, String)] = [
        ("plain", "https://zhiqustudy.com"), ("slash", "https://zhiqustudy.com/"), ("spaces", " http://127.0.0.1:8080 "),
        ("localhost", "http://localhost:18080/"), ("upper", "HTTPS://Zhiqu.TEST:8443"), ("http", "http://zhiqustudy.com"),
        ("lookalike", "http://localhost.evil.com"), ("path", "https://zhiqustudy.com/sub"), ("query", "https://zhiqustudy.com?x=1"),
        ("userinfo", "https://u:p@zhiqustudy.com"), ("fragment", "https://zhiqustudy.com#x"), ("nohost", "https://"), ("js", "javascript:alert(1)"), ("ftp", "ftp://zhiqustudy.com"), ("empty", ""),
    ]
    for (name, text) in cases { out("server.\(name)", Server.acceptable(text)?.absoluteString ?? "nil") }
    out("server.fallback", Server.fallback.absoluteString)
}, until: { true })

// 13. macOS 的 Cmd 编辑键：实际 NSMenu key equivalent -> WKWebView 原生编辑动作。
// 隐藏窗口不成为 keyWindow，AppKit 无法从 NSApp 找它的 firstResponder；因此仅在检查程序中给菜单指定这个
// responder。生产菜单保持 target=nil，交给正常的 keyWindow responder chain；Java 另外钉住外壳接线。
// 不用 execCommand 代替原生快捷键。粘贴板只使用合成正文，完整备份所有类型，做完马上恢复。
let pasteboard = NSPasteboard.general
var oldClipboard: [NSPasteboardItem] = []
var clipboardSaved = false
func saveClipboard() {
    oldClipboard = (pasteboard.pasteboardItems ?? []).map { item in
        let saved = NSPasteboardItem()
        for type in item.types { if let data = item.data(forType: type) { saved.setData(data, forType: type) } }
        return saved
    }
    clipboardSaved = true
}
func restoreClipboard() {
    guard clipboardSaved else { return }
    pasteboard.clearContents()
    if !oldClipboard.isEmpty { pasteboard.writeObjects(oldClipboard) }
    clipboardSaved = false
}
var editState: [String: Any] = [:]
var editHandled: [String: Bool] = [:]
func editRead(_ id: String) {
    editState = [:]
    web.evaluateJavaScript("""
      (() => { const e = document.getElementById('\(id)'); return {
        text: e.tagName === 'TEXTAREA' ? e.value : e.textContent,
        selected: e.tagName === 'TEXTAREA' ? e.value.slice(e.selectionStart, e.selectionEnd) : window.getSelection().toString(),
        focused: document.activeElement === e
      }; })()
    """) { value, error in
        if let error { out("edit.jsError", error.localizedDescription) }
        editState = value as? [String: Any] ?? ["error": true]
    }
}
func editKey(_ label: String, _ letter: String, _ code: UInt16, id: String, flags: NSEvent.ModifierFlags = .command) {
    editState = [:]
    // charactersIgnoringModifiers 仍然保留 Shift，真实的 Cmd+Shift+Z 事件给的是大写 Z。
    let character = flags.contains(.shift) ? letter.uppercased() : letter
    let event = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0,
                                windowNumber: editWindow.windowNumber, context: nil, characters: character,
                                charactersIgnoringModifiers: character, isARepeat: false, keyCode: code)!
    applicationMenu.update()
    editHandled[label] = applicationMenu.performKeyEquivalent(with: event)
    // WebKit 的编辑动作跨进程，等它经过 runloop 后才读正文 / 选区。
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { editRead(id) }
}
func editReport(_ label: String) {
    out("edit.\(label).handled", editHandled[label] ?? false)
    out("edit.\(label).text", editState["text"] as? String ?? "none")
    out("edit.\(label).selected", editState["selected"] as? String ?? "none")
}
step("edit.setup", {
    out("edit.responderTargets", menuUsesResponderChain)
    out("edit.windowHidden", !editWindow.isVisible && !editWindow.isKeyWindow)
    for item in nativeEditItems {
        var responder = editWindow.firstResponder
        while let candidate = responder, let action = item.action, !candidate.responds(to: action) {
            responder = candidate.nextResponder
        }
        item.target = responder
    }
    js("""
      (() => { const e = document.getElementById('native-editor'); e.focus();
        const range = document.createRange(); range.selectNodeContents(e); range.collapse(true);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      })()
    """)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { editRead("native-editor") }
}, until: { !editState.isEmpty })
step("edit.select", { editKey("select", "a", 0, id: "native-editor") }, until: { !editState.isEmpty })
step("edit.select.report", { editReport("select") }, until: { true })
step("edit.copy", { saveClipboard(); editKey("copy", "c", 8, id: "native-editor") }, until: { !editState.isEmpty })
step("edit.copy.report", {
    editReport("copy")
    out("edit.copy.clipboard", pasteboard.string(forType: .string) == "原始正文甲乙")
    restoreClipboard()
}, until: { true })
step("edit.cut", { saveClipboard(); editKey("cut", "x", 7, id: "native-editor") }, until: { !editState.isEmpty })
step("edit.cut.report", { editReport("cut"); restoreClipboard() }, until: { true })
step("edit.undoCut", { editKey("undoCut", "z", 6, id: "native-editor") }, until: { !editState.isEmpty })
step("edit.undoCut.report", { editReport("undoCut") }, until: { true })
step("edit.selectForPaste", { editKey("selectForPaste", "a", 0, id: "native-editor") }, until: { !editState.isEmpty })
step("edit.paste", {
    saveClipboard(); pasteboard.clearContents(); pasteboard.setString("粘贴新正文甲", forType: .string)
    editKey("paste", "v", 9, id: "native-editor")
}, until: { !editState.isEmpty })
step("edit.paste.report", { editReport("paste"); restoreClipboard() }, until: { true })
step("edit.undo", { editKey("undo", "z", 6, id: "native-editor") }, until: { !editState.isEmpty })
step("edit.undo.report", { editReport("undo") }, until: { true })
step("edit.redo", { editKey("redo", "z", 6, id: "native-editor", flags: [.command, .shift]) }, until: { !editState.isEmpty })
step("edit.redo.report", { editReport("redo") }, until: { true })
step("edit.textarea.focus", {
    editState = [:]
    js("document.getElementById('native-textarea').focus()")
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { editRead("native-textarea") }
}, until: { !editState.isEmpty })
step("edit.textarea.select", { editKey("textarea.select", "a", 0, id: "native-textarea") }, until: { !editState.isEmpty })
step("edit.textarea.select.report", { editReport("textarea.select") }, until: { true })
step("edit.textarea.copy", { saveClipboard(); editKey("textarea.copy", "c", 8, id: "native-textarea") }, until: { !editState.isEmpty })
step("edit.textarea.copy.report", {
    editReport("textarea.copy")
    out("edit.textarea.copy.clipboard", pasteboard.string(forType: .string) == "输入框正文丙丁")
    restoreClipboard()
}, until: { true })
step("edit.textarea.paste", {
    saveClipboard(); pasteboard.clearContents(); pasteboard.setString("粘贴新正文", forType: .string)
    editKey("textarea.paste", "v", 9, id: "native-textarea")
}, until: { !editState.isEmpty })
step("edit.textarea.paste.report", { editReport("textarea.paste"); restoreClipboard() }, until: { true })
step("edit.textarea.undo", { editKey("textarea.undo", "z", 6, id: "native-textarea") }, until: { !editState.isEmpty })
step("edit.textarea.undo.report", {
    editReport("textarea.undo")
    restoreClipboard()
    out("edit.windowStayedHidden", !editWindow.isVisible && !editWindow.isKeyWindow)
}, until: { true })

// 一步等不到就记一笔、接着走：后面那些键照样打出来，Java 那边的断言指得到具体是哪件事没做到
var index = 0
var started = Date()
var actionDone = false
Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { timer in
    guard index < steps.count else { restoreClipboard(); out("done", true); exit(0) }
    let (name, action, until) = steps[index]
    if !actionDone { action(); actionDone = true; started = Date(); return }
    if until() { index += 1; actionDone = false; return }
    if Date().timeIntervalSince(started) > 5 { out("timeout.\(name)", true); index += 1; actionDone = false }
}
app.run()
