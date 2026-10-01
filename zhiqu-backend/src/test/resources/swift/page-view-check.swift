// DesktopPageViewTest 的检查程序：和 deploy/desktop/macos-shell/PageView.swift 一起编译（本文件改名成 main.swift），
// 在一个真的 WKWebView 里真点 file input、真点 a[download]、真走外部链接 —— 面板换成不开窗口的桩，其余全是真的。
// 每一步打印一行「键=值」，由 Java 那边断言。用法：check <临时目录>
import AppKit
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
web.reportFailure = { message, _ in failures.append(message) }

let html = """
<html><body><input id=one type=file><input id=many type=file multiple><script>
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

// 8. 外部链接：交给系统浏览器，窗口不走
step("external", { js("location.href = 'https://example.com/x'") }, until: { !opened.isEmpty })
step("external.loc", { location = ""; readLocation() }, until: { !location.isEmpty })
step("external.report", {
    out("external.opened", opened.first?.absoluteString ?? "none")
    out("external.stayed", location == origin)
}, until: { true })

// 一步等不到就记一笔、接着走：后面那些键照样打出来，Java 那边的断言指得到具体是哪件事没做到
var index = 0
var started = Date()
var actionDone = false
Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { timer in
    guard index < steps.count else { out("done", true); exit(0) }
    let (name, action, until) = steps[index]
    if !actionDone { action(); actionDone = true; started = Date(); return }
    if until() { index += 1; actionDone = false; return }
    if Date().timeIntervalSince(started) > 5 { out("timeout.\(name)", true); index += 1; actionDone = false }
}
app.run()
