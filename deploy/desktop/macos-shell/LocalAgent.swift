// 本机代码助手（第一百二十九轮，docs/desktop-remote-plan.md 第 2 步）：外壳按需起包里的 node，跑命令行那一份宿主
// （Resources/zhiqu-cli/src/host/code-host.js），在用户自己的磁盘上读、在系统沙箱里跑命令；模型和远程工具走服务器的网关，
// 用页面签来的一张「本机代码」令牌（12 小时，只认那几个接口）。协议和后端起它的那一份同一个：stdin 一行 run，stdout 一行一个 JSON
// （step / trace / result / fatal），叫停是一行 {"type":"stop"}。
//
// 页面从服务器来，里面有 AI 写的和导入的内容，不全信：run 里要紧的字段外壳自己定 ——
//   - 根目录只认用户在系统选框里选过的文件夹（LocalFolders），页面说不出别的路径；
//   - 服务器地址是外壳自己的 Server.url（令牌只发给自己的网站）；家目录、联网档、时间和轮数也是外壳的。
// 页面能给的是：用哪个选过的文件夹、这句话、前面的对话、模型、思考档位、档位（READ / WRITE / EXEC）、/init /review、令牌。
//
// 单独一个文件、没有顶层代码：DesktopLocalAgentTest 把它和检查程序一起编译、真起 node 跑。

import AppKit
import CryptoKit
import Foundation

/// 用户在系统选框里选过的项目文件夹（存在偏好设置里，最多 20 个，最近选的在前）。本机代码只在这些里面跑
final class LocalFolders {
    static let key = "localFolders"
    static let limit = 20
    let defaults: UserDefaults
    let home: String

    init(defaults: UserDefaults = .standard, home: String = NSHomeDirectory()) {
        self.defaults = defaults
        self.home = LocalFolders.real(home)
    }

    /// 真实路径（解软链、去掉 /./..）：同一个文件夹两种写法要认成一个。不用 URL.resolvingSymlinksInPath ——
    /// 它会把 /private/var、/private/tmp 反过来写成 /var、/tmp（实测），和宿主、沙箱算的真实路径对不上
    static func real(_ path: String) -> String {
        let std = URL(fileURLWithPath: path).standardizedFileURL.path
        guard let resolved = realpath(std, nil) else { return std }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    static func isDirectory(_ path: String) -> Bool {
        var dir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &dir) && dir.boolValue
    }

    /// 还在的那些（删掉、挪走了的不列）
    var all: [String] { (defaults.stringArray(forKey: Self.key) ?? []).filter(LocalFolders.isDirectory) }

    /// 记下一个刚选好的。不收根目录、家目录本身和装着家目录的（整个家目录当工作区，沙箱「读不到家目录」就没了意义）
    func add(_ url: URL) -> (path: String?, error: String?) {
        let p = LocalFolders.real(url.path)
        if p == "/" || p == home || home.hasPrefix(p.hasSuffix("/") ? p : p + "/") {
            return (nil, "不能把整个家目录（或者装着它的文件夹）当项目文件夹，选一个具体的项目")
        }
        guard LocalFolders.isDirectory(p) else { return (nil, "这个文件夹不在了") }
        var list = (defaults.stringArray(forKey: Self.key) ?? []).filter { $0 != p }
        list.insert(p, at: 0)
        defaults.set(Array(list.prefix(Self.limit)), forKey: Self.key)
        return (p, nil)
    }

    /// 页面说的那个是不是选过的（按真实路径比，比完还要在）
    func contains(_ path: String) -> Bool {
        !path.isEmpty && all.contains(LocalFolders.real(path))
    }
}

/// 页面要跑的一轮。只收认得的字段、认得的值；别的（服务器地址、根目录的任意路径……）一概不看
struct LocalRunRequest {
    let folder: String
    let message: String
    let history: [[String: String]]
    let modelId: Int?
    let effort: String?
    let level: String
    let command: String?
    let token: String

    static let levels = ["READ", "WRITE", "EXEC"]
    static let efforts = ["instant", "medium", "high", "extra", "max"]
    static let maxMessage = 200_000
    static let maxHistory = 200

    /// 认得就返回请求，认不得返回说给页面的原因
    static func parse(_ body: [String: Any]) -> (LocalRunRequest?, String?) {
        guard let folder = body["folder"] as? String, !folder.isEmpty else { return (nil, "没说用哪个项目文件夹") }
        guard let level = body["level"] as? String, levels.contains(level) else { return (nil, "档位是关的（close）或者认不出：本机代码要 plan / manual / auto") }
        guard let token = body["token"] as? String, token.range(of: "^zqp_[A-Za-z0-9_-]{16,200}$", options: .regularExpression) != nil else {
            return (nil, "没拿到本机代码的登录令牌")
        }
        let command = (body["command"] as? String).flatMap { ["init", "review"].contains($0) ? $0 : nil }
        let message = (body["message"] as? String) ?? ""
        if message.isEmpty && command == nil { return (nil, "没有要做的事") }
        if message.count > maxMessage { return (nil, "这句话太长了") }
        var history: [[String: String]] = []
        for item in ((body["history"] as? [Any]) ?? []).suffix(maxHistory) {
            guard let m = item as? [String: Any], let role = m["role"] as? String, ["user", "assistant"].contains(role),
                  let content = m["content"] as? String else { continue }
            history.append(["role": role, "content": String(content.prefix(maxMessage))])
        }
        let modelId: Int? = (body["model"] as? Int) ?? (body["model"] as? String).flatMap { Int($0) }
        let effort = (body["effort"] as? String).flatMap { efforts.contains($0) ? $0 : nil }
        return (LocalRunRequest(folder: folder, message: message, history: history, modelId: modelId, effort: effort,
                                level: level, command: command, token: token), nil)
    }
}

/// 起宿主、读它的输出、叫停。一次一轮；所有回调都在主线程
final class LocalAgent {
    struct Config {
        var node: URL
        var host: URL
        var server: URL
        var home: String
        var network: String
        var timeoutMs = 240_000
        /// 工具循环最多几轮。桌面这一轮在本机跑，服务器管不到它 —— 这个数必须和服务器那份
        /// `CodeLoopBudget.EXPLICIT` 对齐，否则同一句话在网页上能做完、在桌面上半路停下。
        /// 原来写死 20：服务器那边第一百三十二轮改成了 40，这里没跟上，用户在桌面上做到一半就撞
        /// 「这一轮用完了 20 轮」。`defaults write com.zhiqu.quadrant maxRounds 60` 可以调（1–120）。
        var maxRounds = LocalAgent.roundsSetting()
    }

    /// 轮数：默认 40（和服务器一致），`defaults write com.zhiqu.quadrant maxRounds N` 可以调
    static func roundsSetting(_ defaults: UserDefaults = .standard) -> Int {
        let v = defaults.integer(forKey: "maxRounds")
        return v > 0 ? min(120, max(1, v)) : 40
    }

    /// 联网档（用户 2026-11-10 定的「所有人都可以联网」：默认开）。`defaults write com.zhiqu.quadrant sandboxNetwork off` 关
    static func networkSetting(_ defaults: UserDefaults = .standard) -> String {
        let v = defaults.string(forKey: "sandboxNetwork") ?? "on"
        return ["off", "local", "on"].contains(v) ? v : "off"
    }

    /// 包里的位置：Resources/node/bin/node、Resources/zhiqu-cli/src/host/code-host.js
    static func bundled(server: URL, bundle: Bundle = .main) -> Config? {
        guard let res = bundle.resourceURL else { return nil }
        return Config(node: res.appendingPathComponent("node/bin/node"),
                      host: res.appendingPathComponent("zhiqu-cli/src/host/code-host.js"),
                      server: server, home: NSHomeDirectory(), network: networkSetting())
    }

    /// 一行太长就不是宿主在说话了（结果里带着草稿的全文，几 MB 正常）
    static let maxLine = 64 << 20

    var config: Config
    private(set) var process: Process?
    private var input: FileHandle?
    private var buffer = Data()
    private var stderrTail = Data()
    private var token = ""
    private var gotResult = false
    private var stdoutDone = false
    private var exited: Int32?
    private var finishedRun = true
    private var work: URL?
    private var onMessage: (([String: Any]) -> Void)?
    private var generation = 0

    init(config: Config) {
        self.config = config
    }

    var available: Bool {
        FileManager.default.isExecutableFile(atPath: config.node.path) && FileManager.default.fileExists(atPath: config.host.path)
    }

    var running: Bool { !finishedRun }

    /// 交给宿主的那一行。要紧的字段只从外壳来：根目录、家目录、服务器、联网、时间和轮数
    static func payload(_ req: LocalRunRequest, root: String, config: Config) -> [String: Any] {
        let write = req.level != "READ" && req.command != "review"
        return [
            "type": "run", "root": root, "home": config.home, "message": req.message, "history": req.history,
            "command": req.command ?? NSNull(),
            // 没有系统沙箱宿主自己不给命令（canShell 只是「可以给」）；从来不给白名单命令和删除
            "canWrite": write, "canExec": false, "canShell": true, "shellWrite": write && req.level == "EXEC",
            "sandboxNetwork": config.network, "maxRounds": config.maxRounds, "timeoutMs": config.timeoutMs,
            "model": ["id": req.modelId.map { $0 as Any } ?? NSNull()], "effort": req.effort ?? "instant",
            "local": ["server": config.server.absoluteString, "token": req.token],
        ]
    }

    /// 宿主看到的环境：不继承外壳的（令牌、代理、别的应用塞进来的变量都不给）。HOME、TMPDIR 是这一轮自己的空目录 ——
    /// 用户的家目录另外经 run.home 交给沙箱去挡。PATH：常见的安装位置在前，包里的 node 放最后（用户自己装的优先）
    static func environment(node: URL, home: URL, tmp: URL, userHome: String) -> [String: String] {
        var dirs: [String] = []
        for d in ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin",
                  userHome + "/.cargo/bin", userHome + "/.local/bin"] where LocalFolders.isDirectory(d) {
            dirs.append(d)
        }
        dirs.append(node.deletingLastPathComponent().path)
        var seen = Set<String>()
        return ["PATH": dirs.filter { seen.insert($0).inserted }.joined(separator: ":"), "HOME": home.path, "TMPDIR": tmp.path, "LANG": "en_US.UTF-8"]
    }

    /// 起一轮。返回 nil = 起来了；否则是说给页面的原因。onMessage 收宿主的每一行，最后一定有一条 {"type":"exit"}
    func start(_ req: LocalRunRequest, root: String, onMessage: @escaping ([String: Any]) -> Void) -> String? {
        guard !running else { return "上一轮还没完，先停下它" }
        guard available else { return "安装包里缺本机代码助手（node 或命令行源码），重新安装一下" }
        let fm = FileManager.default
        let work = fm.temporaryDirectory.appendingPathComponent("zhiqu-local-\(UUID().uuidString)")
        let home = work.appendingPathComponent("home"), tmp = work.appendingPathComponent("tmp")
        do {
            for dir in [home, tmp] { try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
        } catch {
            return "建不了临时目录：\(error.localizedDescription)"
        }
        let p = Process()
        p.executableURL = config.node
        p.arguments = [config.host.path]
        p.currentDirectoryURL = work
        p.environment = LocalAgent.environment(node: config.node, home: home, tmp: tmp, userHome: config.home)
        let stdinPipe = Pipe(), stdoutPipe = Pipe(), stderrPipe = Pipe()
        p.standardInput = stdinPipe
        p.standardOutput = stdoutPipe
        p.standardError = stderrPipe
        generation += 1
        let gen = generation
        p.terminationHandler = { proc in
            DispatchQueue.main.async { [weak self] in self?.exited(proc.terminationStatus, gen) }
        }
        do {
            try p.run()
        } catch {
            try? fm.removeItem(at: work)
            return "本机代码助手起不来：\(error.localizedDescription)"
        }
        self.process = p
        self.input = stdinPipe.fileHandleForWriting
        self.work = work
        self.onMessage = onMessage
        self.token = req.token
        buffer = Data(); stderrTail = Data(); gotResult = false; stdoutDone = false; exited = nil; finishedRun = false
        // 读放在后台线程：阻塞读到 EOF，读到的交回主线程按行拆
        let out = stdoutPipe.fileHandleForReading, err = stderrPipe.fileHandleForReading
        DispatchQueue.global(qos: .userInitiated).async {
            while true {
                let d = out.availableData
                if d.isEmpty { break }
                DispatchQueue.main.async { [weak self] in self?.take(d, gen) }
            }
            DispatchQueue.main.async { [weak self] in self?.stdoutEnded(gen) }
        }
        DispatchQueue.global(qos: .utility).async {
            while true {
                let d = err.availableData
                if d.isEmpty { break }
                DispatchQueue.main.async { [weak self] in
                    guard let self, gen == self.generation else { return }
                    self.stderrTail.append(d)
                    if self.stderrTail.count > 4096 { self.stderrTail = self.stderrTail.suffix(4096) }
                }
            }
        }
        send(LocalAgent.payload(req, root: root, config: config))
        // 宿主自己有时间预算；它要是卡住了（不该），外壳到点也叫停
        let budget = Double(config.timeoutMs) / 1000 + 15
        DispatchQueue.main.asyncAfter(deadline: .now() + budget) { [weak self] in
            guard let self, gen == self.generation, self.running else { return }
            self.stop()
        }
        return nil
    }

    private func send(_ msg: [String: Any]) {
        guard let input, let data = try? JSONSerialization.data(withJSONObject: msg) else { return }
        // 宿主已经退了：写一个关掉的管子会收到 SIGPIPE —— 外壳忽略了 SIGPIPE（ignoreBrokenPipe），这里只是写不进去
        try? input.write(contentsOf: data + Data("\n".utf8))
    }

    /// 叫停：先说 stop（宿主中断、收掉后台命令、照实交 result），5 秒还没退就 SIGTERM，再 3 秒 SIGKILL
    func stop() {
        guard running, let p = process else { return }
        let gen = generation
        send(["type": "stop"])
        let pid = p.processIdentifier
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            guard let self, gen == self.generation, self.exited == nil else { return }
            kill(pid, SIGTERM)
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                guard let self, gen == self.generation, self.exited == nil else { return }
                kill(pid, SIGKILL)
            }
        }
    }

    /// 应用要退出了：不等，直接 SIGTERM（宿主收到也是中断、收掉后台命令）
    func terminate() {
        guard running, let p = process, exited == nil else { return }
        kill(p.processIdentifier, SIGTERM)
    }

    private func take(_ data: Data, _ gen: Int) {
        guard gen == generation else { return }
        buffer.append(data)
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<nl]
            buffer = Data(buffer[(nl + 1)...])
            handle(Data(line))
        }
        if buffer.count > LocalAgent.maxLine {
            buffer = Data()
            deliver(["type": "fatal", "message": "本机代码助手的输出一行超过 \(LocalAgent.maxLine >> 20) MB，停下了"])
            gotResult = true
            stop()
        }
    }

    private func handle(_ line: Data) {
        guard !line.isEmpty, let msg = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any], let type = msg["type"] as? String else { return }
        switch type {
        case "step", "trace":
            deliver(msg)
        case "result", "fatal":
            gotResult = true
            deliver(msg)
        default:
            // model / exec / tool：本机模式下宿主不该要（它自己连网关、自己跑命令）。没人回它就一直等 —— 直接停下
            deliver(["type": "fatal", "message": "本机代码助手要了外壳不做的事（\(type.prefix(20))），停下了"])
            gotResult = true
            stop()
        }
    }

    /// 交给页面之前再挡一次令牌（宿主已经换过；stderr 拼出来的那句是外壳自己的）
    private func deliver(_ msg: [String: Any]) {
        guard let onMessage else { return }
        if token.count >= 8, let data = try? JSONSerialization.data(withJSONObject: msg), let text = String(data: data, encoding: .utf8), text.contains(token),
           let clean = text.replacingOccurrences(of: token, with: "zqp_…").data(using: .utf8),
           let obj = (try? JSONSerialization.jsonObject(with: clean)) as? [String: Any] {
            onMessage(obj)
        } else {
            onMessage(msg)
        }
    }

    private func stdoutEnded(_ gen: Int) {
        guard gen == generation else { return }
        if !buffer.isEmpty { handle(buffer); buffer = Data() }
        stdoutDone = true
        finishIfDone()
    }

    private func exited(_ status: Int32, _ gen: Int) {
        guard gen == generation else { return }
        exited = status
        // 输出一般先读完；有孙子进程攥着管子时 EOF 可能一直不来 —— 等 2 秒就不等了
        if !stdoutDone {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                guard let self, gen == self.generation, !self.finishedRun else { return }
                self.stdoutDone = true
                self.finishIfDone()
            }
        }
        finishIfDone()
    }

    private func finishIfDone() {
        guard !finishedRun, stdoutDone, let status = exited else { return }
        if !gotResult {
            let tail = String(decoding: stderrTail, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            deliver(["type": "fatal", "message": "本机代码助手意外退出了（退出码 \(status)）" + (tail.isEmpty ? "" : "：\(String(tail.suffix(600)))")])
        }
        deliver(["type": "exit", "code": Int(status)])
        finishedRun = true
        try? input?.close()
        input = nil
        process = nil
        onMessage = nil
        token = ""
        if let work { try? FileManager.default.removeItem(at: work) }
        work = nil
    }
}

/// 确认草稿时写进选过的项目文件夹。页面不可信：路径必须留在这个文件夹里，基线不符一个字节都不写。
/// 基线是第一次改它时磁盘上的 SHA-256（小写十六进制），文件本来没有是 `ABSENT`（和命令行草稿同一份）。
enum LocalDrafts {
    static let absent = "ABSENT"
    static let maxFiles = 40
    static let maxBytes = 1_000_000

    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// 留在项目文件夹里的路径。`..`、绝对路径、软链指到外面、目标是文件夹，都不要
    static func resolve(_ root: String, _ rel: String) -> String? {
        if rel.isEmpty || rel.count > 512 || rel.contains("\0") || rel.contains("\\") || rel.hasPrefix("/") { return nil }
        let parts = rel.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        if parts.isEmpty || parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) { return nil }
        let base = LocalFolders.real(root)
        guard LocalFolders.isDirectory(base) else { return nil }
        var current = base
        for (i, part) in parts.enumerated() {
            let next = (current as NSString).appendingPathComponent(part)
            if FileManager.default.fileExists(atPath: next) {
                let resolved = LocalFolders.real(next)
                if resolved != base && !resolved.hasPrefix(base + "/") { return nil }
                if i == parts.count - 1 {
                    return LocalFolders.isDirectory(resolved) ? nil : resolved
                }
                if !LocalFolders.isDirectory(resolved) { return nil }
                current = resolved
            } else {
                let dest = (current as NSString).appendingPathComponent(parts[i...].joined(separator: "/"))
                if dest != base && !dest.hasPrefix(base + "/") { return nil }
                return dest
            }
        }
        return nil
    }

    /// 先全部对一遍基线，再写。已经是要写的内容（确认重试）算成功。返回 nil 表示可以了
    static func apply(folder: String, files: [[String: Any]]) -> String? {
        let base = LocalFolders.real(folder)
        guard LocalFolders.isDirectory(base) else { return "这个项目文件夹不在了" }
        if files.isEmpty { return "没有要写入的文件" }
        if files.count > maxFiles { return "一次最多写 \(maxFiles) 个文件" }
        struct Job { let dest: String; let data: Data }
        var jobs: [Job] = []
        var seen = Set<String>()
        var total = 0
        for raw in files {
            guard let rel = raw["path"] as? String, !rel.isEmpty else { return "有一个文件没写路径" }
            if !seen.insert(rel).inserted { return "同一个文件写了两次：" + rel }
            guard let dest = resolve(base, rel) else { return "这个路径不能写：" + rel }
            guard let baseline = raw["baseline"] as? String,
                  baseline == absent || baseline.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
                return "基线不对：" + rel
            }
            let content = (raw["content"] as? String) ?? ""
            let data = Data(content.utf8)
            if data.count > maxBytes { return rel + " 太大了" }
            total += data.count
            if total > maxBytes * 8 { return "这一批太大了" }
            let current = FileManager.default.contents(atPath: dest)
            let now = current.map { sha256($0) } ?? absent
            if now == sha256(data) { continue }
            if now != baseline { return rel + " 和你看到的不一样了，没有写入" }
            jobs.append(Job(dest: dest, data: data))
        }
        for job in jobs {
            let parent = (job.dest as NSString).deletingLastPathComponent
            if !FileManager.default.fileExists(atPath: parent) {
                do { try FileManager.default.createDirectory(atPath: parent, withIntermediateDirectories: true) }
                catch { return "建不了目录：" + parent }
            }
            let parentReal = LocalFolders.real(parent)
            if parentReal != base && !parentReal.hasPrefix(base + "/") { return "这个路径不能写" }
            do { try job.data.write(to: URL(fileURLWithPath: job.dest), options: .atomic) }
            catch { return "写不进去：" + job.dest }
        }
        return nil
    }

    /// 确认框里要比的「现在的内容」。太大、不是文本，就说原因
    static func read(folder: String, path: String) -> (body: [String: Any]?, error: String?) {
        guard let dest = resolve(folder, path) else { return (nil, "这个路径不能读") }
        if !FileManager.default.fileExists(atPath: dest) { return (["content": "", "absent": true], nil) }
        guard let data = FileManager.default.contents(atPath: dest) else { return (nil, "读不到这个文件") }
        if data.count > maxBytes { return (nil, "这个文件太大，确认框里对不了") }
        guard let text = String(data: data, encoding: .utf8) else { return (nil, "这个文件不是文本") }
        return (["content": text, "absent": false], nil)
    }
}

/// 写一个对面已经关掉的管子默认会收到 SIGPIPE、整个应用退出；外壳和检查程序启动时都调一次
func ignoreBrokenPipe() {
    signal(SIGPIPE, SIG_IGN)
}
