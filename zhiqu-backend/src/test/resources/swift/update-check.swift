// 桌面自更新的判据（第一百三十二轮）：和 Updater.swift 一起编译，跑纯逻辑那一半 ——
// 版本比较、清单解析、sha256、换掉自己的那个脚本。网络和真正的替换不在这里跑
// （替换要退出应用，跑一次就等于把测试机上的应用换掉了）。
//
// 输出 key=value，最后一行 done=true；Java 那边（DesktopUpdaterTest）按行取。
import Foundation

let work = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : NSTemporaryDirectory())

func out(_ key: String, _ value: String) { print("\(key)=\(value)") }
func flag(_ key: String, _ value: Bool) { out(key, value ? "true" : "false") }

// 版本比较：按数字逐段比，不是按字符串
flag("newer.patch", UpdateCheck.isNewer("1.1.0", than: "1.0.0"))
flag("newer.number", UpdateCheck.isNewer("1.0.10", than: "1.0.9"))      // 字符串比会得到 false
flag("newer.same", UpdateCheck.isNewer("1.0.0", than: "1.0.0"))
flag("newer.older", UpdateCheck.isNewer("0.9.9", than: "1.0.0"))
flag("newer.short", UpdateCheck.isNewer("1.1", than: "1.0.9"))          // 少写一段
flag("newer.suffix", UpdateCheck.isNewer("1.2.0-beta1", than: "1.1.9")) // 带后缀

// 解析 /api/desktop/downloads
let server = URL(string: "https://zhiqustudy.com")!
let json = """
{"code":200,"message":"success","data":{"macos":{"platform":"macos","fileName":"知趣象限-1.1.0.dmg","size":41925556,\
"version":"1.1.0","sha256":"78865C60BF0604D241E4625F716679CD3B8DB52D2541CF3EFE5C5138C52914A0","url":"/api/desktop/downloads/macos"},\
"windows":null}}
""".data(using: .utf8)!
if let r = UpdateCheck.release(from: json, server: server) {
    out("parse.version", r.version)
    out("parse.url", r.url.absoluteString)
    out("parse.size", String(r.size))
    out("parse.sha", r.sha256)
} else {
    out("parse.version", "nil")
}

let empty = #"{"code":200,"data":{"macos":null}}"#.data(using: .utf8)!
flag("parse.none", UpdateCheck.release(from: empty, server: server) == nil)
flag("parse.broken", UpdateCheck.release(from: Data("不是 JSON".utf8), server: server) == nil)

// sha256：abc 的标准值
let sample = work.appendingPathComponent("abc.txt")
try? Data("abc".utf8).write(to: sample)
out("sha.abc", (try? UpdateCheck.sha256(of: sample)) ?? "nil")

// 换掉自己的脚本：要等进程退出、要 ditto、要重新打开、要清临时目录
let helper = Updater.helperScript
flag("helper.waits", helper.contains("while kill -0 \"$pid\""))
flag("helper.copies", helper.contains("/usr/bin/ditto"))
flag("helper.opens", helper.contains("/usr/bin/open"))
flag("helper.cleans", helper.contains("rm -rf \"$work\""))
// 先拷到旁边再换：拷到一半失败时原来那个还在
flag("helper.swaps", helper.contains("next=\"$dst.new\"") && helper.contains("mv \"$next\" \"$dst\""))

// 检查程序不是 .app：退回 0.0.0，不能崩
out("bundle.version", Updater.bundleVersion)

out("done", "true")
