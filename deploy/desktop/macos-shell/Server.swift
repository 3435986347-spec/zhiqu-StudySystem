// 桌面应用打开哪个网站（第一百二十五轮）。单独一个文件：ZhiquShell.swift 有顶层代码，检查程序没法和它一起编译，
// 这一份和 PageView.swift 一样跟着 DesktopPageViewTest 的检查程序编进去、真跑。
import Foundation

/// 默认 https://zhiqustudy.com；开发时用环境变量 ZHIQU_DESKTOP_SERVER 或
/// `defaults write com.zhiqu.quadrant server http://127.0.0.1:8080` 指到别处。
/// 只认 https，http 只给本机（登录令牌不能走明文过公网）；认不出的照默认来。
enum Server {
    static let fallback = URL(string: "https://zhiqustudy.com")!

    static let url: URL = {
        let given = ProcessInfo.processInfo.environment["ZHIQU_DESKTOP_SERVER"]
            ?? UserDefaults.standard.string(forKey: "server")
        return given.flatMap(acceptable) ?? fallback
    }()

    /// 认得的地址：https 的任何主机，或者本机的 http；只要「协议 + 主机 + 端口」，路径、查询、用户名密码一概不收
    static func acceptable(_ text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let parts = URLComponents(string: trimmed),
              let scheme = parts.scheme?.lowercased(), let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil,
              parts.path.isEmpty || parts.path == "/", parts.query == nil, parts.fragment == nil else { return nil }
        // 主机名一律小写：页面里导航的地址 WebKit 给的是小写的，按原样比就成了「A.com 不是自己的网站」，什么都往外开
        let loopback = ["127.0.0.1", "localhost"].contains(host)
        guard scheme == "https" || (scheme == "http" && loopback) else { return nil }
        var clean = URLComponents()
        clean.scheme = scheme
        clean.host = host
        clean.port = parts.port
        return clean.url
    }

    static func page(_ name: String) -> URL { url.appendingPathComponent(name) }
}
