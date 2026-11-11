# 桌面应用（原生 macOS 外壳）

> 原来是 `CLAUDE.md` 里的「桌面应用（原生 macOS 外壳）」，第三十八轮（方案第 5 步，`CLAUDE.md` 瘦身）原样挪到这里，一字未改。
> `CLAUDE.md` 现在只留规矩；这里是来龙去脉和细节。文中「上面」「下面」指的是原来 `CLAUDE.md` 里的位置。
>
> **第一百二十五轮起 macOS 外壳打开网站、包里不带 Java**（见最后一节）：下面讲 JVM、jlink、端口文件、上传目录、本机 MySQL 的几段
> 对 Windows 版（jpackage，还带后端）和历史仍然有用，对 Mac 版已经不适用。

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

**迷你番茄钟的悬浮面板**（第五十一轮，`deploy/desktop/macos-shell/MiniPanel.swift`，`docs/mini-pomodoro-plan.md` 第 3 步）。
看板的番茄钟卡片上「缩小到桌面」（只在桌面应用里出现：页面看得到 `window.webkit.messageHandlers.zqMini` 才显示）→ 页面发 `{action:'shrink'}`，
外壳把主窗口 `orderOut`、拿出一个 `NSPanel`：无边框、透明（`isOpaque=false`、底色 clear、不要窗口影子 —— 胶囊的影子是页面自己画的，
窗口的影子是方的）、`.nonactivatingPanel`（点它不会把应用切到前台）、`.floating`、`canJoinAllSpaces` + `fullScreenAuxiliary`、`hidesOnDeactivate=false`
（面板默认在应用切到后台时藏起来，迷你窗恰恰是给在别的应用里干活的时候看的）、`canBecomeKey` 覆写成 true（无边框面板默认当不了键窗口，按钮用键盘按不到）、
`setFrameAutosaveName("ZhiquMiniPanel")` 记位置（第一次在主屏幕右上角）。里面是第二个 `PageView` 打开 `mini.html`（`.default()` 网站数据，和主窗口同一个登录、同一个钟）。
**拖动**：WKWebView 吃掉鼠标事件，`isMovableByWindowBackground` 对它盖住的地方不起作用 —— 胶囊中间（时间和小字，没有能点的东西）盖一块 `MiniDragZone`
（`mouseDownCanMoveWindow`），两边的按钮不盖。胶囊上「展开」发 `{action:'expand'}`：面板收起、主窗口回来；点 Dock 图标、点通知、迷你模式下 Cmd+Tab 切回来（胶囊不会让应用到前台，
所以应用到了前台一定是人特意切过来的）也一样。`PageView` 对 `zqMini` 只认 `shrink` / `expand`。
**实测（2026-10-09，检查程序里两个共用一份网站数据的 WKWebView）**：localStorage 互相读得到、`navigator.locks` 是同一把（到点只响一次靠它），
但 **storage 事件不在两个 WKWebView 之间传**（放进窗口里也不传）—— 页面不靠它：一秒一跳、`visibilitychange` 时马上按存的刷一次（藏着的主窗口一拿出来就跟上）。
登录不一样：胶囊里登录失效时写「在主窗口登录后再用」、不再跳，主窗口重新登录（或换了账号）它看不出来 —— 所以面板建过之后**每次缩小都重新载入胶囊**（`miniPage?.reload()`，第五十八轮 review）。
`DesktopPageViewTest` 把 `MiniPanel.swift` 一起编进检查程序，建一个面板核对这些设定（不放到屏幕上）、点得到两边的按钮、中间拖得动。

## 代码模式带的 node（第九十六轮）

网页 / 桌面应用的代码模式跑命令行那份循环（`JsCodeAgent` 起 node，见 `docs/notes/code-workspace.md`）。macOS 打包默认下载固定的官方 ARM64 Node 22.23.2，
按源码固定的 SHA256 校验、缓存到 `build/node-runtime`，运行时与 LICENSE 放进 `Contents/Resources/node/`（第一百零一轮）。外壳用 `-Dapp.ai.code-agent.node=` 告诉后端；
命令行源码在 JAR 里（pom 的 `bundle-zhiqu-cli`），后端第一次用时解到临时目录。第一百零一轮本机产物：node v22 未压缩 108MiB，应用包 240MiB、dmg 143MiB。
macOS 包只带 ARM64；显式 `NODE_BIN` 要指向带 LICENSE 的完整发行目录内的 `bin/node`，检查 Node ≥ 18.17、兼容 macOS 13.0、只依赖系统库，
不再默认搬 PATH 上的 Homebrew Node（会缺 libnode 等外部库）。准备失败在构建 JAR / 删除旧包之前停止，离线办法见 `deploy/desktop/README.md`。
Windows 包仍带本机的 `node\node.exe`（`NODE_EXE`），路径用 jpackage 的 `$APPDIR`。
**外壳（Swift）改了，要重新打包才到用户手里。**

## 从网页版下载（第八十二轮）

网页版的落地页和头像菜单里有「下载桌面版」，安装包从后端的下载目录拿（`app.desktop-downloads-dir`，服务器上是 `C:/zhiqu/downloads`）：
打完包把 `知趣象限-<版本>.dmg` 拷进去就出现，不用重启 —— 服务器上用 `deploy/windows/install-desktop-download.ps1`（见 `deploy/windows/README.md` 十三之三）（一百多 MB 要拷一会儿：先用点开头的名字拷、拷完再改名，拷到一半时不会被当成最新的发出去）；Windows 的 `.exe` / 免安装目录打成的 `.zip` 也放这里。
dmg 一百多 MB，超过 GitHub 单个文件的上限，也不能进 `static/`（会打进 JAR，桌面包里再装一份安装包）。

这个包只能装在 Apple 芯片、macOS 13 以上的 Mac 上；只是临时签名、没有公证：`spctl` 对下载来的（带隔离属性的）副本判 rejected，
别人第一次打开要到「系统设置 → 隐私与安全性」点「仍要打开」，说「已损坏」时用 `xattr -dr com.apple.quarantine` 去掉隔离属性。
下载的人还要有一个 MySQL：桌面版自带后端，默认连本机的 `zhiqu_db`，地址在 `~/.zhiqu/application.yml` 里改（见 `deploy/desktop/remote-database.md`）——
连不上时后端起不来，外壳报「后端没有在 60 秒内就绪。请检查数据库是否可连接」（第八十二轮量过：数据库连不上，后端重试 48 秒后退出，外壳当场报）。

- **后端的日志写进 `~/.zhiqu/logs/backend.log`**（第九十轮，`application-desktop.yml`，10MB 滚动、留 5 份）：外壳起后端时不接 stdout，原来日志哪儿都不落，网关回 `upstream_error` 时没处查原因。

## 打开网站、包里不带 Java（第一百二十五轮）

用户 2026-11-08 定了桌面版给所有下载的人用、数据走网站（`docs/desktop-remote-plan.md`）。外壳原来起包里的 Java 后端、连用户自己装的 MySQL，
窗口里开 `http://127.0.0.1:47615`；现在窗口里直接打开 `Server.page("dashboard.html")`（`macos-shell/Server.swift`：默认 `https://zhiqustudy.com`，
环境变量 `ZHIQU_DESKTOP_SERVER` 或 `defaults write com.zhiqu.quadrant server …` 能改；只认 https，http 只给本机；只要协议 + 主机 + 端口、主机名小写）。
包里去掉了瘦 JAR、jlink 的 JRE、`CdsCache.swift`（给 JVM 做启动加速的类归档）；node 留着给本机代码助手（方案第 2 步）。

页面从服务器来、里面有 AI 写的和导入的内容，外壳的几道门跟着收紧（`PageView.swift`，`DesktopPageViewTest` 在真的 WKWebView 里验）：

- **桥（`zqNotify`、`zqMini`）只认自己网站的主框架**：`frameInfo.isMainFrame` + 来源是名单里的主机（不是本机的只认 https）。
  AI 生成的 HTML 预览是 sandbox 的 srcdoc iframe，桥在每个框里都看得见 —— 原来一段生成的网页就能弹通知、把主窗口缩没。
  两道各有只有它照得出来的样本：`allow-same-origin` 的框来源就是这个网站，只有「主框架」挡得住；名单外来源的主框架，只有「来源」挡得住。
- **链接按服务器那一个主机分里外**（原来写死 127.0.0.1 / localhost）；同一主机的明文页面算外面。
- **框里的脚本自己跳走（不是人点的）就地拦下**，不叫系统浏览器；交给系统的只有 http / https / mailto（`file://` 会在 Finder 里打开，`.app` 就是运行它）。
- **载入结果告诉外壳**：载入完了收起「正在连接」；连不上、主框架回 5xx（后端重启时 Caddy 回的是正文为空的 502，窗口一片白）照实说、告诉人按 ⌘R；
  被新导航顶掉的那一次（-999）不算。菜单加了「显示 → 重新载入」（target 留空：页面有焦点时 WKWebView 接，页面是空的时落到外壳）。
- **实现了回应策略（看 5xx 要用它）就得自己管显示不了的类型**：照样放行，WebKit 报「因策略改变中断」（102），外壳会盖上「连不上」。
  主框架打开一个文件（zip、附件）转成下载（走保存面板），框里的不理；转下载那一次的 102 不算没载入成。
  转出来的下载在保存面板里点「取消」会走到 `didFailWithError`（页面上 `a[download]` 的不会）—— 不记下来，用户点了取消反倒看到「没有保存成功」。

检查程序里起一个本机的小 HTTP 服务器（`NWListener`）回 200 / 502 / 慢回包，去不在跑的端口验连不上 —— 不用 1 这类端口：WebKit 自己拦着「受限端口」、根本不发请求，
一个回调都不来（第一次就撞上了）。`DesktopPageViewTest` 的检查程序现在编一次、跑一次，各条共用（原来每条各编各跑）。
**检查程序里每个 PageView 的面板和提示都要换成桩**：这一轮新建的那个页面漏了 `reportFailure`，默认的是 `NSAlert.runModal` ——
跑判据时「没有保存成功」的系统提示框弹到了用户的屏幕上（用户以为是磁盘满了）。

验证真应用时**不要让它打开线上网站**（那是用户的真账号）：`defaults write com.zhiqu.quadrant server http://127.0.0.1:18080`，后端连 `zhiqu_verify` 库。

## 本机代码助手（第一百二十九轮，方案第 2 步）
- 外壳 `LocalAgent.swift` 按需起包里的 node 跑 `Resources/zhiqu-cli/src/host/code-host.js`（打包脚本拷 `zhiqu-cli/package.json` + `src/`）。协议和后端起它的那一份同一个；
  run 里带 `local: { server, token }` 就是本机模式：模型、模型列表、远程工具直接走网站的网关（命令行的 `Api`），命令在本机系统沙箱里跑（`DesktopTools`），写只成草稿。
- 令牌：页面用网页的登录态 `POST /api/access-tokens/desktop-code` 签一张（`DESKTOP_CODE`，12 小时，只认 `GET /api/harness/models`、`POST /api/harness/model/stream`、
  `GET /api/harness/tools`、`POST /api/harness/tools/call`），经 `zqLocal` 桥交给外壳、外壳经 stdin 交给宿主；宿主和外壳发给页面的每一行里出现令牌都换成 `zqp_…`。
- 页面不可信，run 里要紧的字段外壳自己定：根目录只认用户在系统选框里选过的（`LocalFolders`，存偏好设置，不收 `/`、家目录和装着家目录的；路径用 `realpath` ——
  `URL.resolvingSymlinksInPath` 会把 `/private/var` 写回 `/var`）、服务器是 `Server.url`、家目录、联网档（`defaults write com.zhiqu.quadrant sandboxNetwork off|local|on`，默认 on）。
- 宿主的环境只有 `PATH`、`HOME`、`TMPDIR`、`LANG`（HOME / TMPDIR 是这一轮自己的空目录）；沙箱挡的家目录经 `run.home` 另给 —— 照宿主自己的 HOME 算会挡错地方。
- 叫停：stdin 一行 `{"type":"stop"}` → 5 秒 SIGTERM → 3 秒 SIGKILL；宿主收到 stop / SIGTERM / stdin 关掉都中断、收掉后台命令、照实交 result。应用退出时 SIGTERM。
- 桥 `zqLocal`（带回复）：`status` / `pick` / `run` / `stop`；事件是 `window` 上的 `zq-local`（detail 是宿主的一行 + `runId`，最后一定有 `{type: 'exit'}`）。只认自己网站的主框架，只有主窗口接。
- 判据：`DesktopLocalAgentTest`（真编译外壳、真起 node、真沙箱、Java 起的假网关）、`zhiqu-cli/test/desktop-host.test.js`。页面那一侧（选文件夹的按钮、代码模式在桌面里走桥、确认草稿写盘）是第 3 步。

