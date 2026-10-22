import Foundation

/// 启动加速：应用类的 CDS 归档（第十轮）。
///
/// 实测（2026-09-28，同一台机器、同一个库）：现在的包从拉起 JVM 到 Spring 就绪约 3.3 秒；
/// 给运行时加上基础 CDS（jlink `--generate-cds-archive`）几乎不变；再加上**应用类**的归档是 1.7 秒 —— 快一半。
///
/// 应用类归档只能在用户机器上生成：JDK 17 要求运行时的类路径和生成归档时**一字不差**，而应用装在哪
/// （/Applications 还是下载目录）打包时不知道。JDK 19 的 `-XX:+AutoCreateSharedArchive` 能全自动，17 没有，
/// 所以这里自己管，规矩只有三条：
/// 1. 有归档就用（`-XX:SharedArchiveFile`）；路径变了、JDK 变了，JVM 自己判不匹配、照常启动，只是慢；
/// 2. 没有就这一次顺带生成（`-XX:ArchiveClassesAtExit`），写到 `.part` 临时文件 —— JVM 退出时才写，约 3 秒；
/// 3. **只有我们正常结束了它（SIGTERM 后它自己退出），才把 `.part` 改名成正式归档**；等不及被 SIGKILL 的、
///    自己崩掉的，`.part` 可能只写了一半，删掉，下次再生成。半截的归档 JVM 多半能认出来，但不赌这个。
///
/// 归档按「JAR 路径 + 大小 + 修改时间 + java 路径」起名：换了版本、挪了位置就是新的一份，旧的在新的生成后清掉。
/// 这个文件只用 Foundation，不碰 AppKit —— `DesktopCdsCacheTest` 单独编译它、不开窗口地跑一遍这三条。
struct CdsCache {
    let directory: URL
    let archive: URL
    let partial: URL

    init(directory: URL, jar: URL, java: URL) {
        self.directory = directory
        let attrs = (try? FileManager.default.attributesOfItem(atPath: jar.path)) ?? [:]
        let size = (attrs[.size] as? NSNumber)?.int64Value ?? 0
        let mtime = Int64(((attrs[.modificationDate] as? Date) ?? Date(timeIntervalSince1970: 0)).timeIntervalSince1970)
        let key = CdsCache.fnv1a("\(jar.path)|\(size)|\(mtime)|\(java.path)")
        archive = directory.appendingPathComponent("app-\(key).jsa")
        partial = directory.appendingPathComponent("app-\(key).jsa.part")
    }

    /// 这次要不要顺带生成（没有正式归档）。
    var training: Bool {
        !FileManager.default.fileExists(atPath: archive.path)
    }

    /// 加在 `-jar` 之前的 JVM 参数。
    func jvmArguments() -> [String] {
        if !training {
            return ["-XX:SharedArchiveFile=\(archive.path)"]
        }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: partial)   // 上次没收尾的半截
        return ["-XX:ArchiveClassesAtExit=\(partial.path)"]
    }

    /// JVM 结束之后调用。`cleanExit`：是我们发了 SIGTERM、它自己退出的（不是被 SIGKILL，也不是自己崩的）。
    func finish(cleanExit: Bool) {
        let fm = FileManager.default
        guard fm.fileExists(atPath: partial.path) else { return }
        let size = ((try? fm.attributesOfItem(atPath: partial.path))?[.size] as? NSNumber)?.int64Value ?? 0
        guard cleanExit, size > 0 else {
            try? fm.removeItem(at: partial)
            return
        }
        try? fm.removeItem(at: archive)
        guard (try? fm.moveItem(at: partial, to: archive)) != nil else { return }
        // 旧版本 / 旧位置的归档：新的这份生成了才清，免得清完了新的又没生成。
        // 按文件名比，不按 URL 比：contentsOfDirectory 给回来的 URL 和自己拼的那个即使指向同一个文件也可能不相等
        // （/var 与 /private/var 之类）—— 第一版就是这么把刚生成的归档当成「旧的」删掉的，DesktopCdsCacheTest 红出来的
        let keep = archive.lastPathComponent
        let others = (try? fm.contentsOfDirectory(atPath: directory.path)) ?? []
        for name in others where name.hasPrefix("app-") && name != keep {
            try? fm.removeItem(at: directory.appendingPathComponent(name))
        }
    }

    /// 64 位 FNV-1a：稳定的短哈希（Swift 的 hashValue 每个进程都不一样，不能拿来起文件名）。
    static func fnv1a(_ text: String) -> String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in text.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01b3
        }
        return String(hash, radix: 16)
    }
}

/// 应用 JAR 的 ASCII 路径副本（第十轮，量出来的）。
///
/// JDK 17 的应用类归档对**路径里有非 ASCII 字符**的 JAR 只归档一小部分：同一份文件，放在 `知趣象限.app` 里
/// 生成的归档 64MB、启动 2.15 秒；拷到 ASCII 路径下是 86MB、1.66 秒。和 locale 无关（LC_ALL 换成什么都一样），
/// 软链也不行（JVM 会解开软链、按真实路径算）。应用包的名字就是中文，所以在用户机器上拷一份到 `~/.zhiqu/app/<版本>/`
/// 再从那里跑 —— macOS 的账户短名只能是 ASCII，家目录路径一定是 ASCII；APFS 上 copyItem 是克隆，不占空间、瞬间完成。
///
/// 只在确实需要（路径里有非 ASCII 字符）时才拷；拷完最后写一个 `.complete` 标记，没有标记的目录一律当半截；
/// 拷不成（磁盘满、没权限）就照原样从应用包里跑 —— 只是慢一点，功能不受影响。
enum AppStage {
    static func runnableJar(bundleApp: URL, jar: URL, root: URL) -> URL {
        guard jar.path.unicodeScalars.contains(where: { !$0.isASCII }) else { return jar }
        let fm = FileManager.default
        let attrs = (try? fm.attributesOfItem(atPath: jar.path)) ?? [:]
        let size = (attrs[.size] as? NSNumber)?.int64Value ?? 0
        let mtime = Int64(((attrs[.modificationDate] as? Date) ?? Date(timeIntervalSince1970: 0)).timeIntervalSince1970)
        let key = CdsCache.fnv1a("\(jar.path)|\(size)|\(mtime)")
        let target = root.appendingPathComponent(key)
        let staged = target.appendingPathComponent(jar.lastPathComponent)
        if fm.fileExists(atPath: target.appendingPathComponent(".complete").path) {
            return staged
        }
        let tmp = root.appendingPathComponent("\(key).tmp-\(ProcessInfo.processInfo.processIdentifier)")
        do {
            try fm.createDirectory(at: root, withIntermediateDirectories: true)
            try? fm.removeItem(at: tmp)
            try fm.copyItem(at: bundleApp, to: tmp)
            try Data().write(to: tmp.appendingPathComponent(".complete"))
            try? fm.removeItem(at: target)   // 没有标记的半截旧目录
            try fm.moveItem(at: tmp, to: target)
        } catch {
            try? fm.removeItem(at: tmp)
            return jar
        }
        // 旧版本的副本：新的这份齐了才清（按名字比，理由见 CdsCache.finish）
        let keep = target.lastPathComponent
        for name in (try? fm.contentsOfDirectory(atPath: root.path)) ?? [] where name != keep {
            try? fm.removeItem(at: root.appendingPathComponent(name))
        }
        return staged
    }
}
