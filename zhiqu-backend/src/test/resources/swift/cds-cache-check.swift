// DesktopCdsCacheTest 的检查程序：和 deploy/desktop/macos-shell/CdsCache.swift 一起编译（改名成 main.swift），
// 在一个临时目录里把外壳会走的那几步真走一遍，每一步打印一行「键=值」，由 Java 那边断言。不开窗口、不起 JVM。
import Foundation

let tmp = URL(fileURLWithPath: CommandLine.arguments[1])
let dir = tmp.appendingPathComponent("cds")
let jar = tmp.appendingPathComponent("app.jar")
let java = tmp.appendingPathComponent("java")
let fm = FileManager.default
func exists(_ u: URL) -> Bool { fm.fileExists(atPath: u.path) }
func dump(_ c: CdsCache) { try! Data(repeating: 7, count: 4096).write(to: c.partial) }   // 模拟 JVM 退出时写归档

try! "v1".write(to: jar, atomically: true, encoding: .utf8)
print("fnv=\(CdsCache.fnv1a("zhiqu"))")

// 第一次：没有归档 → 这次生成，写到 .part
var c = CdsCache(directory: dir, jar: jar, java: java)
print("first.training=\(c.training)")
print("first.args=\(c.jvmArguments().joined(separator: " "))")
dump(c)
c.finish(cleanExit: true)
print("afterClean.archive=\(exists(c.archive)) afterClean.partial=\(exists(c.partial))")

// 第二次：有归档 → 用它
c = CdsCache(directory: dir, jar: jar, java: java)
print("second.training=\(c.training)")
print("second.args=\(c.jvmArguments().joined(separator: " "))")

// 换了版本（JAR 变了）→ 新的一份；这次被 SIGKILL 了 → .part 删掉、旧的正式归档先不动
try! "v2-different-size".write(to: jar, atomically: true, encoding: .utf8)
let v2 = CdsCache(directory: dir, jar: jar, java: java)
print("v2.newName=\(v2.archive != c.archive) v2.training=\(v2.training)")
_ = v2.jvmArguments()
dump(v2)
v2.finish(cleanExit: false)
print("afterKill.partial=\(exists(v2.partial)) afterKill.archive=\(exists(v2.archive)) afterKill.oldKept=\(exists(c.archive))")

// 上次留下的半截 .part：下次生成之前先清掉
try! Data(repeating: 1, count: 10).write(to: v2.partial)
_ = v2.jvmArguments()
print("stalePartialRemoved=\(!exists(v2.partial))")

// 这次正常结束 → 新的落成正式文件，旧版本的清掉
dump(v2)
v2.finish(cleanExit: true)
print("v2.archive=\(exists(v2.archive)) oldRemoved=\(!exists(c.archive))")

// 空的 .part（JVM 没来得及写）不能当成归档
let v3jar = tmp.appendingPathComponent("other.jar")
try! "v3".write(to: v3jar, atomically: true, encoding: .utf8)
let v3 = CdsCache(directory: dir, jar: v3jar, java: java)
_ = v3.jvmArguments()
try! Data().write(to: v3.partial)
v3.finish(cleanExit: true)
print("emptyPromoted=\(exists(v3.archive)) emptyRemoved=\(!exists(v3.partial))")

// ── AppStage：中文路径的应用包拷一份到 ASCII 路径再跑 ──
let bundle = tmp.appendingPathComponent("知趣象限.app/app")
try! fm.createDirectory(at: bundle.appendingPathComponent("lib"), withIntermediateDirectories: true)
let bjar = bundle.appendingPathComponent("zhiqu-backend.jar")
try! "thin".write(to: bjar, atomically: true, encoding: .utf8)
try! "dep".write(to: bundle.appendingPathComponent("lib/dep.jar"), atomically: true, encoding: .utf8)
let stageRoot = tmp.appendingPathComponent("stage")
let s1 = AppStage.runnableJar(bundleApp: bundle, jar: bjar, root: stageRoot)
print("stage.ascii=\(!s1.path.unicodeScalars.contains(where: { !$0.isASCII })) stage.jarCopied=\(exists(s1)) stage.libCopied=\(exists(s1.deletingLastPathComponent().appendingPathComponent("lib/dep.jar"))) stage.marker=\(exists(s1.deletingLastPathComponent().appendingPathComponent(".complete")))")
// 第二次：已有完整副本，直接用、不重拷
try! "changed-in-stage".write(to: s1, atomically: true, encoding: .utf8)
let s2 = AppStage.runnableJar(bundleApp: bundle, jar: bjar, root: stageRoot)
print("stage.reused=\(s2 == s1 && (try! String(contentsOf: s2, encoding: .utf8)) == "changed-in-stage")")
// 没有 .complete 标记的副本当半截：重拷
try! fm.removeItem(at: s1.deletingLastPathComponent().appendingPathComponent(".complete"))
let s3 = AppStage.runnableJar(bundleApp: bundle, jar: bjar, root: stageRoot)
print("stage.recopiedHalf=\((try! String(contentsOf: s3, encoding: .utf8)) == "thin")")
// 应用更新了：新的一份，旧的清掉
try! "thin-v2-longer".write(to: bjar, atomically: true, encoding: .utf8)
let s4 = AppStage.runnableJar(bundleApp: bundle, jar: bjar, root: stageRoot)
print("stage.newVersion=\(s4 != s3 && exists(s4)) stage.oldRemoved=\(!exists(s3))")
// 路径本来就是 ASCII：不拷
let asciiJar = tmp.appendingPathComponent("plain/app/x.jar")
try! fm.createDirectory(at: asciiJar.deletingLastPathComponent(), withIntermediateDirectories: true)
try! "x".write(to: asciiJar, atomically: true, encoding: .utf8)
print("stage.asciiUntouched=\(AppStage.runnableJar(bundleApp: asciiJar.deletingLastPathComponent(), jar: asciiJar, root: tmp.appendingPathComponent("stage2")) == asciiJar && !exists(tmp.appendingPathComponent("stage2")))")
// 拷不成（根目录是个文件，建不了目录）：照原样从应用包跑
let blocked = tmp.appendingPathComponent("blocked")
try! "file".write(to: blocked, atomically: true, encoding: .utf8)
print("stage.fallback=\(AppStage.runnableJar(bundleApp: bundle, jar: bjar, root: blocked.appendingPathComponent("sub")) == bjar)")
