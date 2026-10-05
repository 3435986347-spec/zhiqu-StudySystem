# 桌面应用（原生 macOS 外壳）

> 原来是 `CLAUDE.md` 里的「桌面应用（原生 macOS 外壳）」，第三十八轮（方案第 5 步，`CLAUDE.md` 瘦身）原样挪到这里，一字未改。
> `CLAUDE.md` 现在只留规矩；这里是来龙去脉和细节。文中「上面」「下面」指的是原来 `CLAUDE.md` 里的位置。

### 桌面应用（原生 macOS 外壳）

`deploy/desktop/package-macos-native.sh` 产出一个真正的 Cocoa 应用：Swift + WKWebView 外壳，
JVM 作为子进程，页面无边框铺满窗口，并封成拖拽安装的 `.dmg`。Windows 版见 `package-windows.ps1`
（只能在 Windows 上打，jpackage 不做跨平台）。

三个只在**打包产物**里出现、且报错指不到原因的坑，都已修并有判据：

- **`ApplicationRunner` 比 `ApplicationReadyEvent` 先跑。** Spring Boot 先 `callRunners()`
  再发 ready 事件，所以 runner 里读不到实际端口。`DesktopLauncher` 现在只用一个
  `@EventListener(ApplicationReadyEvent.class)`。
- **Spring Boot 默认 `java.awt.headless=true`**，`Desktop.isDesktopSupported()` 必然 false。
  开浏览器改走 `/usr/bin/open` / `rundll32` / `xdg-open`（`BrowserOpener`）。
  而 headless 的 JVM 不连 CoreGraphics 窗口服务器，macOS 会**无限弹跳 Dock 图标**
  （`lsappinfo` 报 `!cgsConnection`）。jpackage 版必须传
  `--java-options "-Djava.awt.headless=false"` —— `spring.main.headless` 绑定在
  `configureHeadlessProperty()` 之后，**写了也不生效**。原生外壳版相反：JVM 保持 headless，
  外壳自己才是 GUI 进程。
- **jlink 漏了 `jdk.charsets`**，MySQL 驱动把连接字符集协商成 `eucjpms`，
  所有中文明文写入报 `Incorrect string value`。表、列、JDBC URL 三处都写着 utf8mb4。
  任务标题是加密存储的（明文进 `encrypted_title`），所以只有 Wiki 受影响。
  `jdk.crypto.ec` 同理：缺了 HTTPS 握手失败，报错像是对端的问题。

**WKWebView 不实现代理方法就不做浏览器理所当然的事，而且不报错**（2026-10-01，用户报「Wiki 导入来源 → 上传文件解析，点了没反应」）。
没有 `runOpenPanelWith`，`<input type="file">` 一点就被当成取消，系统面板根本不出来（AI 助手上传资料、换头像同一个原因）；
导航策略对 `<a download href="blob:…">` 回 `.allow` 的话，**整个应用窗口被导航成那份文件的原文**，无边框窗口没有后退（Wiki 导出、下载原件）。
这些都收在 `deploy/desktop/macos-shell/PageView.swift`：WKWebView 的子类、自己当自己的代理 —— `uiDelegate` 是 weak 的，
写成 `webView.uiDelegate = SomeHelper()` 当场就被释放、又回到「点了没反应」。两个实测出来、不看代码想不到的：在保存面板里点取消
**不会**走到 `didFailWithError`；而写不进只读目录时 WebKit 报的恰恰是 `NSURLErrorCancelled`、说明为空 —— 按「取消」滤掉就成了一声不吭。
`DesktopPageViewTest` 把 PageView.swift 和检查程序一起编译，在真的 WKWebView 里真点 file input、真点 a[download]（面板换成桩）。
**外壳的改动要重新打包才到用户手里**（`package-macos-native.sh`），网页的改动不用。

**WKWebView 里网页的 `Notification` 存在，但 `requestPermission()` 直接回 `"denied"`、什么都不弹**（2026-10-04 实测）。
所以页面在桌面版里发通知走外壳的桥 `window.webkit.messageHandlers.zqNotify`（`PageView` 只认 `notify` / `authorize`，各字段有长度上限），
外壳用 `UNUserNotificationCenter` 发原生通知；`ZhiquShell` 是通知中心的代理（前台也显示横幅、点了把窗口拉到前面）。
消息处理者挂的是 `WeakMessageHandler` —— `userContentController` 强持有处理者，直接挂 PageView 自己是循环引用。

原生外壳与后端靠 `-Dzhiqu.desktop.port-file` 交接端口（临时文件 + 原子改名 —— 外壳是
轮询这个文件的，直接写可能读到半个端口号）。设了这个属性后端就**不再弹浏览器**。

**桌面应用的工作目录是 `/`**（从 Finder / Dock 启动，实测 `user.dir=/`）。所以凡是按
`user.dir` 解析的相对路径，在桌面版里都指向只读的根目录 —— `app.upload-dir`（头像、分享计划）
和 `app.private-upload-dir`（AI 资料原件）两个都中招。2026-09-23 的样子：⌘V 贴一张图，
界面写「已附到下一条消息」，模型却说看不到、资料区下载为空 —— 原件写不进 `/private-uploads`，
而那段代码是 `catch (Exception ignored)`，之后照样标 `UPLOADED`。`application-desktop.yml`
现在把两个键都设成 `~/.zhiqu/` 下的绝对路径；`DesktopUploadDirTest` **从代码里扫出**所有相对的
`*-dir` 键再核对（不手写名单 —— 第一版就只改了 `upload-dir`，贴图照样坏）。落盘失败时图片标
`ERROR` 并写明原因（文本资料只是降级：文本已从上传流抽出），读不到原件的图也会告诉模型。
