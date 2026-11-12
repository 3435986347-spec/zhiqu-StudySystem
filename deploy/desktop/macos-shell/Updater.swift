//
//  Updater.swift
//  桌面版自更新（第一百三十二轮）。
//
//  用户：「能不能做到桌面应用版里面的自己获取更新，然后提示是否要更新重启应用，不然每次都要打包下载，
//  很麻烦。就像 codex 和 dsh 那样，左下角有一个更新下载的提示，点击后自动更新」。
//
//  服务器那边不用改：第八十二轮就有 /api/desktop/downloads（网页「下载桌面版」用的那个），
//  返回每个平台最新安装包的 version / size / sha256 / url。外壳只做四件事：
//  问一句、比版本、下载并核对 sha256、换掉自己再重新打开。
//
//  为什么不是 SparkKit 之类：包里只带一个 node 运行时，没有第三方依赖；这件事本身也就两百行。
//

import AppKit
import CryptoKit
import Foundation

/// 服务器上的一份安装包（`/api/desktop/downloads` 里 macos 那一项）
struct UpdateRelease: Equatable {
    let version: String
    let fileName: String
    let size: Int64
    let sha256: String
    /// 完整下载地址（服务器给的是相对路径）
    let url: URL
}

/// 更新走到哪一步。界面只认这个。
enum UpdatePhase: Equatable {
    case idle
    case available(UpdateRelease)
    case downloading(received: Int64, total: Int64)
    /// 下载完、sha256 对上了，等用户点一下再重启（不替用户决定什么时候断）
    case ready(UpdateRelease)
    case installing
    case failed(String)

    var release: UpdateRelease? {
        switch self {
        case .available(let r), .ready(let r): return r
        default: return nil
        }
    }
}

struct UpdateFailure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

/// 纯逻辑：版本比较、解析清单、算 sha256。拆出来是为了能编进检查程序里真跑（见 DesktopUpdaterTest）。
enum UpdateCheck {

    /// 版本号比较：按 `.` 分段、逐段按数字比（"1.0.10" > "1.0.9"）。
    /// 只看前三段；带 `-beta` 之类后缀的只取数字部分（服务器上的文件名只写 x.y.z）。
    static func isNewer(_ candidate: String, than current: String) -> Bool {
        let a = parts(candidate), b = parts(current)
        for i in 0..<3 {
            let x = i < a.count ? a[i] : 0
            let y = i < b.count ? b[i] : 0
            if x != y { return x > y }
        }
        return false
    }

    static func parts(_ version: String) -> [Int] {
        version.split(separator: "-").first.map(String.init)?.split(separator: ".").map { Int($0.prefix(while: \.isNumber)) ?? 0 } ?? []
    }

    /// 解析 `/api/desktop/downloads`：`{"code":200,"data":{"macos":{...}}}`。没有 macos 那一项就当没有新版本。
    static func release(from data: Data, server: URL) -> UpdateRelease? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let payload = root["data"] as? [String: Any],
              let mac = payload["macos"] as? [String: Any],
              let version = mac["version"] as? String,
              let sha = mac["sha256"] as? String,
              let rel = mac["url"] as? String else { return nil }
        let path = rel.hasPrefix("/") ? String(rel.dropFirst()) : rel
        guard !path.isEmpty else { return nil }
        return UpdateRelease(version: version,
                             fileName: mac["fileName"] as? String ?? "update.dmg",
                             size: (mac["size"] as? NSNumber)?.int64Value ?? 0,
                             sha256: sha.lowercased(),
                             url: server.appendingPathComponent(path))
    }

    /// 边读边算，不把 40MB 整个读进内存
    static func sha256(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

/// 问版本、下载、换掉自己。网络和安装都在后台队列，`phase` 只在主线程改。
final class Updater: NSObject {

    var onChange: ((UpdatePhase) -> Void)?

    private(set) var phase: UpdatePhase = .idle {
        didSet { if phase != oldValue { onChange?(phase) } }
    }

    private let server: URL
    private let current: String
    private var session: URLSession!
    private var pending: UpdateRelease?
    private var dmg: URL?

    init(server: URL = Server.url, current: String = Updater.bundleVersion) {
        self.server = server
        self.current = current
        super.init()
        session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    }

    /// 应用自己的版本号（打包脚本写进 Info.plist 的那个）
    static var bundleVersion: String {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0.0.0"
    }

    /// 问服务器有没有新版本。网络不通、服务器在重启 —— 都当没有，不打扰用户。
    func check() {
        if case .downloading = phase { return }
        if case .installing = phase { return }
        let url = server.appendingPathComponent("api/desktop/downloads")
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.cachePolicy = .reloadIgnoringLocalCacheData
        session.dataTask(with: request) { [weak self] data, _, _ in
            guard let self, let data,
                  let release = UpdateCheck.release(from: data, server: self.server),
                  UpdateCheck.isNewer(release.version, than: self.current) else { return }
            DispatchQueue.main.async {
                // 正在下载 / 等重启时不要被下一次轮询盖回去
                if case .idle = self.phase { self.phase = .available(release) }
            }
        }.resume()
    }

    /// 用户点了那颗胶囊：开始下载
    func download() {
        guard case .available(let release) = phase else { return }
        pending = release
        phase = .downloading(received: 0, total: release.size)
        let task = session.downloadTask(with: release.url)
        task.resume()
    }

    /// 用户点了「重启完成更新」：换掉 .app，然后退出（由 helper 重新打开）
    func restart() {
        guard case .ready(let release) = phase, let dmg else { return }
        phase = .installing
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try self.install(dmg: dmg, version: release.version)
                DispatchQueue.main.async { NSApp.terminate(nil) }
            } catch {
                DispatchQueue.main.async { self.phase = .failed(error.localizedDescription) }
            }
        }
    }

    // MARK: - 换掉自己

    private func install(dmg: URL, version: String) throws {
        let target = Bundle.main.bundleURL
        guard target.pathExtension == "app" else {
            throw UpdateFailure("这一份不是装好的应用（在 \(target.path)），不替你换。")
        }
        let parent = target.deletingLastPathComponent()
        guard FileManager.default.isWritableFile(atPath: parent.path) else {
            throw UpdateFailure("没有权限写 \(parent.path)，请到网站上手动下载 \(version)。")
        }

        let work = FileManager.default.temporaryDirectory.appendingPathComponent("zhiqu-update-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        let mount = work.appendingPathComponent("mnt")
        try FileManager.default.createDirectory(at: mount, withIntermediateDirectories: true)

        try run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount.path, dmg.path])
        defer { _ = try? run("/usr/bin/hdiutil", ["detach", mount.path, "-force"]) }

        let entries = (try? FileManager.default.contentsOfDirectory(atPath: mount.path)) ?? []
        guard let appName = entries.first(where: { $0.hasSuffix(".app") }) else {
            throw UpdateFailure("安装包里没有 .app（\(entries.joined(separator: "、"))）")
        }
        let fresh = work.appendingPathComponent("new.app")
        try run("/usr/bin/ditto", [mount.appendingPathComponent(appName).path, fresh.path])
        // 从网上下的包会带隔离标记，不清掉 Gatekeeper 会拦
        _ = try? run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", fresh.path])

        let script = work.appendingPathComponent("install.sh")
        try Self.helperScript.write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)

        // 不等它：这个脚本要等我们退出才动手，父进程一退出它就被 launchd 收养，继续跑完
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/bash")
        child.arguments = [script.path,
                           String(ProcessInfo.processInfo.processIdentifier),
                           fresh.path, target.path, work.path]
        try child.run()
    }

    /// 一次性脚本：等主程序退出 → 先拷一份新的到旁边 → 换上去 → 重新打开 → 清掉临时目录。
    /// 为什么不在进程里做：正在运行的 bundle 不能一边跑一边被删（换完还得重新打开自己）。
    /// 为什么先拷到旁边：拷到一半失败（磁盘满、权限）时原来那个还在，用户不会落得一个都没有。
    static let helperScript = """
    #!/bin/bash
    # 知趣象限自更新（用完即删）：$1 进程号，$2 新的 .app，$3 要替换的 .app，$4 临时目录
    set -u
    pid="$1"; src="$2"; dst="$3"; work="$4"
    while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
    next="$dst.new"
    rm -rf "$next"
    if /usr/bin/ditto "$src" "$next"; then
      mv "$dst" "$dst.old" 2>/dev/null
      if mv "$next" "$dst"; then
        rm -rf "$dst.old"
        /usr/bin/open "$dst"
      else
        mv "$dst.old" "$dst" 2>/dev/null
        /usr/bin/osascript -e 'display alert "更新没有完成" message "替换应用失败，原来的版本已经放回去了。"'
      fi
    else
      rm -rf "$next"
      /usr/bin/osascript -e 'display alert "更新没有完成" message "复制新版本失败，原来的应用没有动。请到 zhiqustudy.com 重新下载安装包。"'
    fi
    rm -rf "$work"
    """

    @discardableResult
    private func run(_ tool: String, _ args: [String]) throws -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        p.standardOutput = Pipe()
        p.standardError = Pipe()
        try p.run()
        p.waitUntilExit()
        if p.terminationStatus != 0 {
            throw UpdateFailure("\(tool) 失败（退出码 \(p.terminationStatus)）")
        }
        return p.terminationStatus
    }
}

extension Updater: URLSessionDownloadDelegate {

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                    totalBytesExpectedToWrite: Int64) {
        let total = totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : (pending?.size ?? 0)
        DispatchQueue.main.async {
            guard case .downloading = self.phase else { return }
            self.phase = .downloading(received: totalBytesWritten, total: total)
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didFinishDownloadingTo location: URL) {
        // 这个回调一返回，location 就被系统删了：先搬走
        let kept = FileManager.default.temporaryDirectory.appendingPathComponent("zhiqu-\(UUID().uuidString).dmg")
        do {
            try FileManager.default.moveItem(at: location, to: kept)
        } catch {
            DispatchQueue.main.async { self.phase = .failed("下载的文件存不下来：\(error.localizedDescription)") }
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let sum = (try? UpdateCheck.sha256(of: kept)) ?? ""
            DispatchQueue.main.async {
                guard let release = self.pending else { return }
                if !release.sha256.isEmpty && sum != release.sha256 {
                    try? FileManager.default.removeItem(at: kept)
                    self.phase = .failed("下载的包和服务器上的对不上（sha256），没有安装。")
                    return
                }
                self.dmg = kept
                self.phase = .ready(release)
            }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error, (error as NSError).code != NSURLErrorCancelled else { return }
        DispatchQueue.main.async {
            if case .installing = self.phase { return }
            self.phase = .failed("下载失败：\(error.localizedDescription)")
        }
    }
}
