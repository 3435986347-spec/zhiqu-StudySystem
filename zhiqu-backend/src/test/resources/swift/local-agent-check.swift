// DesktopLocalAgentTest 的检查程序（第一百二十九轮）：和 deploy/desktop/macos-shell 的 LocalAgent.swift、PageView.swift、Server.swift、MiniPanel.swift
// 一起编译（本文件改名成 main.swift）。真起 node 跑命令行的宿主、真沙箱、Java 那边起的假网关；选文件夹的系统框换成不开面板的桩。
// 每一步打印一行「键=值」，由 Java 那边断言。用法：check <临时目录> <node> <code-host.js> <网关地址> <令牌>
import AppKit
import WebKit

let args = CommandLine.arguments
let tmp = URL(fileURLWithPath: args[1])
let nodeURL = URL(fileURLWithPath: args[2])
let hostURL = URL(fileURLWithPath: args[3])
let gateway = URL(string: args[4])!
let token = args[5]
let fm = FileManager.default
let proj = tmp.appendingPathComponent("proj")
let home = tmp.appendingPathComponent("home")
try! fm.createDirectory(at: proj, withIntermediateDirectories: true)
try! fm.createDirectory(at: home, withIntermediateDirectories: true)
try! "hello-project\n".write(to: proj.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)
try! "HOME-SECRET\n".write(to: home.appendingPathComponent("secret.txt"), atomically: true, encoding: .utf8)

func out(_ key: String, _ value: Any) { print("\(key)=\(value)"); fflush(stdout) }
func json(_ v: Any) -> String {
    guard let d = try? JSONSerialization.data(withJSONObject: v), let s = String(data: d, encoding: .utf8) else { return "\(v)" }
    return s
}

ignoreBrokenPipe()
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let suite = "zhiqu-local-agent-check-\(ProcessInfo.processInfo.processIdentifier)"
let defaults = UserDefaults(suiteName: suite)!
let config = LocalAgent.Config(node: nodeURL, host: hostURL, server: gateway, home: LocalFolders.real(home.path), network: "off")
out("budget.defaultRounds", LocalAgent.roundsSetting(defaults))
out("budget.timeoutMs", config.timeoutMs)
defaults.set(120, forKey: "maxRounds")
out("budget.configuredRounds", LocalAgent.roundsSetting(defaults))
defaults.set(999, forKey: "maxRounds")
out("budget.clampedRounds", LocalAgent.roundsSetting(defaults))
defaults.removeObject(forKey: "maxRounds")
func request(_ message: String, level: String = "WRITE", folder: String = proj.path) -> LocalRunRequest {
    LocalRunRequest.parse(["folder": folder, "message": message, "level": level, "token": token, "model": 7]).0!
}

// 一步一步来：每一步做一件事，等到条件成立（或超时）再下一步
var steps: [(String, Double, () -> Void, () -> Bool)] = []
func step(_ name: String, timeout: Double = 8, _ action: @escaping () -> Void, until: @escaping () -> Bool) { steps.append((name, timeout, action, until)) }

// —— 一、直接用 LocalAgent：一轮从起到交 result ——
let agent = LocalAgent(config: config)
var runA: [[String: Any]] = []
step("a", timeout: 40, {
    out("a.available", agent.available)
    // 宿主看到的环境只有这四个（不继承外壳的：令牌、代理、别的应用塞进来的变量都不给）
    out("a.envKeys", LocalAgent.environment(node: nodeURL, home: tmp, tmp: tmp, userHome: home.path).keys.sorted().joined(separator: ","))
    out("a.payloadServer", ((LocalAgent.payload(request("x"), root: proj.path, config: config)["local"] as? [String: Any])?["server"] as? String) ?? "")
    let failed = agent.start(request("A-RUN"), root: LocalFolders.real(proj.path)) { runA.append($0) }
    out("a.started", failed ?? "ok")
}, until: { runA.contains { $0["type"] as? String == "exit" } })
step("a.report", {
    out("a.types", runA.compactMap { $0["type"] as? String }.reduce(into: [String]()) { if $0.last != $1 { $0.append($1) } }.joined(separator: ","))
    let result = runA.first { $0["type"] as? String == "result" } ?? [:]
    out("a.conclusion", (result["conclusion"] as? String) ?? "none")
    out("a.error", (result["error"] as? String) ?? "none")
    out("a.drafts", ((result["drafts"] as? [[String: Any]]) ?? []).compactMap { $0["path"] as? String }.joined(separator: ","))
    out("a.diskNew", fm.fileExists(atPath: proj.appendingPathComponent("new.txt").path))
    out("a.tokenLeak", runA.contains { json($0).contains(token) })
    out("a.exit", (runA.last?["code"] as? Int) ?? -1)
    out("a.runningAfter", agent.running)
}, until: { true })

// —— 二、叫停：模型一直不回 → 停 → 照实说、进程没了；跑着的时候再起一轮被拒 ——
var runB: [[String: Any]] = []
var pidB: Int32 = 0
var stoppedAt = Date()
step("b.start", {
    out("b.started", agent.start(request("HANG", level: "READ"), root: LocalFolders.real(proj.path)) { runB.append($0) } ?? "ok")
    pidB = agent.process?.processIdentifier ?? 0
}, until: { agent.running })
step("b.busy", { out("b.busy", agent.start(request("HANG"), root: proj.path) { _ in } ?? "ok") }, until: { true })
step("b.stop", timeout: 15, { DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { stoppedAt = Date(); agent.stop() } },
     until: { runB.contains { $0["type"] as? String == "exit" } })
step("b.report", {
    let result = runB.first { $0["type"] as? String == "result" } ?? [:]
    out("b.stopped", (result["stopped"] as? Bool) ?? false)
    out("b.conclusion", (result["conclusion"] as? String) ?? "none")
    out("b.seconds", String(format: "%.1f", Date().timeIntervalSince(stoppedAt)))
    out("b.processGone", pidB > 0 && kill(pidB, 0) != 0)
}, until: { true })

// —— 三、宿主没交 result 就退了：照实说退出码和它说了什么（令牌照样不出现）——
let crash = tmp.appendingPathComponent("crash.mjs")
try! """
import readline from 'node:readline';
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => { const run = JSON.parse(line); process.stderr.write('boom ' + run.local.token + '\\n'); process.exit(3); });
""".write(to: crash, atomically: true, encoding: .utf8)
var crashConfig = config
crashConfig.host = crash
let crashAgent = LocalAgent(config: crashConfig)
var runC: [[String: Any]] = []
step("c", { out("c.started", crashAgent.start(request("x"), root: proj.path) { runC.append($0) } ?? "ok") },
     until: { runC.contains { $0["type"] as? String == "exit" } })
step("c.report", {
    let fatal = runC.first { $0["type"] as? String == "fatal" } ?? [:]
    out("c.fatal", ((fatal["message"] as? String) ?? "none").replacingOccurrences(of: "\n", with: " "))
    out("c.tokenLeak", runC.contains { json($0).contains(token) })
}, until: { true })

// —— 四、包里缺东西：不起，照实说 ——
var missing = config
missing.node = tmp.appendingPathComponent("no-such-node")
step("d", {
    let m = LocalAgent(config: missing)
    out("d.available", m.available)
    out("d.start", m.start(request("x"), root: proj.path) { _ in } ?? "ok")
}, until: { true })

// —— 五、桥：页面经 zqLocal 问 ——
final class Inbox: NSObject, WKScriptMessageHandler {
    var messages: [String] = []
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) { messages.append("\(m.body)") }
}
let inbox = Inbox()
let web = PageView(frame: NSRect(x: 0, y: 0, width: 600, height: 400), persistent: false)
web.configuration.userContentController.add(inbox, name: "t")
web.localAgent = LocalAgent(config: config)
web.localFolders = LocalFolders(defaults: defaults, home: home.path)
var nextFolder: URL? = nil
var picks = 0
web.chooseFolder = { panel, _, done in
    picks += 1
    out("pick.panel", panel.canChooseDirectories && !panel.canChooseFiles)
    done(nextFolder)
}
let html = """
<!doctype html><html><body>
<iframe id="f" srcdoc="<script>webkit.messageHandlers.zqLocal.postMessage({action:'pick'}).then(r => parent.postMessage('frame:ok:' + JSON.stringify(r), '*'), e => parent.postMessage('frame:err:' + (e && e.message || e), '*'));</script>"></iframe>
<script>
const say = (s) => webkit.messageHandlers.t.postMessage(s);
window.addEventListener('message', (e) => { if (typeof e.data === 'string' && e.data.startsWith('frame:')) say(e.data); });
window.addEventListener('zq-local', (e) => say('ev:' + JSON.stringify(e.detail)));
async function call(tag, body) {
  try { say(tag + ':ok:' + JSON.stringify(await webkit.messageHandlers.zqLocal.postMessage(body))); }
  catch (e) { say(tag + ':err:' + (e && e.message || e)); }
}
say('ready');
</script></body></html>
"""
web.loadHTMLString(html, baseURL: URL(string: "http://127.0.0.1:47615/"))
func has(_ prefix: String) -> Bool { inbox.messages.contains { $0.hasPrefix(prefix) } }
func message(_ prefix: String) -> String { inbox.messages.first { $0.hasPrefix(prefix) } ?? "none" }
func js(_ s: String) { web.evaluateJavaScript(s + "; 0") { _, e in if let e { out("jsError", e.localizedDescription) } } }
let projPath = LocalFolders.real(proj.path)

step("load", {}, until: { has("ready") && has("frame:") })
step("frame.report", { out("bridge.frame", message("frame:")); out("bridge.framePicks", picks) }, until: { true })
step("status", { js("call('status', {action: 'status'})") }, until: { has("status:") })
step("status.report", { out("bridge.status", message("status:")) }, until: { true })
step("notPicked", { js("call('notPicked', {action: 'run', folder: '\(projPath)', message: 'BRIDGE', level: 'READ', token: '\(token)'})") }, until: { has("notPicked:") })
step("notPicked.report", { out("bridge.notPicked", message("notPicked:")) }, until: { true })
step("pickHome", { nextFolder = home; js("call('pickHome', {action: 'pick'})") }, until: { has("pickHome:") })
step("pickHome.report", { out("bridge.pickHome", message("pickHome:")) }, until: { true })
step("pickCancel", { nextFolder = nil; js("call('pickCancel', {action: 'pick'})") }, until: { has("pickCancel:") })
step("pickCancel.report", { out("bridge.pickCancel", message("pickCancel:")) }, until: { true })
step("pick", { nextFolder = proj; js("call('pick', {action: 'pick'})") }, until: { has("pick:") })
step("pick.report", { out("bridge.pick", message("pick:")); out("bridge.folders", web.localFolders.all.joined(separator: ",")) }, until: { true })
// 确认写盘：只写选过的文件夹里的相对路径；基线不符、软链指到外面、没选过的，一个字节都不写
let outside = tmp.appendingPathComponent("outside")
try! fm.createDirectory(at: outside, withIntermediateDirectories: true)
try! fm.createSymbolicLink(at: proj.appendingPathComponent("out"), withDestinationURL: outside)
let baseline = LocalDrafts.sha256(try! Data(contentsOf: proj.appendingPathComponent("a.txt")))
func applyBody(_ files: [[String: Any]], folder: String = projPath) -> String {
    json(["action": "apply", "folder": folder, "files": files] as [String: Any])
}
step("applyEscape", { js("call('applyEscape', \(applyBody([["path": "../x", "content": "no", "baseline": "ABSENT"]])))") }, until: { has("applyEscape:") })
step("applyEscape.report", { out("bridge.applyEscape", message("applyEscape:")) }, until: { true })
step("applyLink", { js("call('applyLink', \(applyBody([["path": "out/p.txt", "content": "no", "baseline": "ABSENT"]])))") }, until: { has("applyLink:") })
step("applyLink.report", { out("bridge.applyLink", message("applyLink:")); out("bridge.applyLinkDisk", fm.fileExists(atPath: outside.appendingPathComponent("p.txt").path)) }, until: { true })
step("applyStale", { js("call('applyStale', \(applyBody([["path": "a.txt", "content": "no\n", "baseline": "ABSENT"]])))") }, until: { has("applyStale:") })
step("applyStale.report", {
    out("bridge.applyStale", message("applyStale:"))
    out("bridge.applyStaleDisk", ((try? String(contentsOf: proj.appendingPathComponent("a.txt"), encoding: .utf8)) ?? "").replacingOccurrences(of: "\n", with: "\\n"))
}, until: { true })
step("applyOk", { js("call('applyOk', \(applyBody([["path": "a.txt", "content": "next\n", "baseline": baseline]])))") }, until: { has("applyOk:") })
step("applyOk.report", {
    out("bridge.applyOk", message("applyOk:"))
    out("bridge.applyOkDisk", ((try? String(contentsOf: proj.appendingPathComponent("a.txt"), encoding: .utf8)) ?? "").replacingOccurrences(of: "\n", with: "\\n"))
}, until: { true })
step("applyAgain", { js("call('applyAgain', \(applyBody([["path": "a.txt", "content": "next\n", "baseline": baseline]])))") }, until: { has("applyAgain:") })
step("applyAgain.report", { out("bridge.applyAgain", message("applyAgain:")) }, until: { true })
step("read", { js("call('read', \(json(["action": "read", "folder": projPath, "path": "a.txt"])))") }, until: { has("read:") })
step("read.report", { out("bridge.read", message("read:")) }, until: { true })
step("readOut", { js("call('readOut', \(json(["action": "read", "folder": projPath, "path": "out/p.txt"])))") }, until: { has("readOut:") })
step("readOut.report", { out("bridge.readOut", message("readOut:")) }, until: { true })
step("applyOther", { js("call('applyOther', \(applyBody([["path": "a.txt", "content": "x", "baseline": "ABSENT"]], folder: outside.path)))") }, until: { has("applyOther:") })
step("applyOther.report", { out("bridge.applyOther", message("applyOther:")) }, until: { true })
step("off", { js("call('off', {action: 'run', folder: '\(projPath)', message: 'BRIDGE', level: 'OFF', token: '\(token)'})") }, until: { has("off:") })
step("off.report", { out("bridge.off", message("off:")) }, until: { true })
step("badToken", { js("call('badToken', {action: 'run', folder: '\(projPath)', message: 'BRIDGE', level: 'READ', token: 'eyJhbGciOiJIUzI1NiJ9.x.y'})") }, until: { has("badToken:") })
step("badToken.report", { out("bridge.badToken", message("badToken:")) }, until: { true })
// 页面多塞一个服务器地址、一个根目录：外壳不看（假网关记得住请求，Java 那边看请求到了它那里）
step("run", timeout: 30, {
    js("call('run', {action: 'run', folder: '\(projPath)', message: 'BRIDGE', level: 'READ', model: 7, token: '\(token)', server: 'http://127.0.0.1:1', root: '/', home: '/tmp'})")
}, until: { inbox.messages.contains { $0.hasPrefix("ev:") && $0.contains("\"type\":\"exit\"") } })
step("run.report", {
    out("bridge.run", message("run:"))
    let events = inbox.messages.filter { $0.hasPrefix("ev:") }
    out("bridge.events", events.count)
    out("bridge.result", events.first { $0.contains("\"type\":\"result\"") }.map { $0.replacingOccurrences(of: "\n", with: " ") } ?? "none")
    out("bridge.eventLeak", events.contains { $0.contains(token) })
    out("bridge.runIds", Set(events.compactMap { e -> String? in
        guard let d = e.dropFirst(3).data(using: .utf8), let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return nil }
        return o["runId"] as? String
    }).sorted().joined(separator: ","))
}, until: { true })

// 迷你窗那样没设 localAgent 的页面：一律说没有
let mini = PageView(frame: NSRect(x: 0, y: 0, width: 300, height: 68), persistent: false)
let miniInbox = Inbox()
mini.configuration.userContentController.add(miniInbox, name: "t")
step("mini", {
    mini.loadHTMLString("<script>webkit.messageHandlers.zqLocal.postMessage({action:'status'}).then(r => webkit.messageHandlers.t.postMessage('mini:ok:' + JSON.stringify(r)), e => webkit.messageHandlers.t.postMessage('mini:err:' + e.message));</script>",
                        baseURL: URL(string: "http://127.0.0.1:47615/"))
}, until: { !miniInbox.messages.isEmpty })
step("mini.report", { out("bridge.mini", miniInbox.messages.first ?? "none") }, until: { true })

var index = 0
var started = Date()
var actionDone = false
Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
    guard index < steps.count else { defaults.removePersistentDomain(forName: suite); out("done", true); exit(0) }
    let (name, timeout, action, until) = steps[index]
    if !actionDone { action(); actionDone = true; started = Date(); return }
    if until() { index += 1; actionDone = false; return }
    if Date().timeIntervalSince(started) > timeout { out("timeout.\(name)", true); index += 1; actionDone = false }
}
app.run()
