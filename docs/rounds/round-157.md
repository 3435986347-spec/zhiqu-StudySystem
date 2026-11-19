# 第一百五十七轮（2026-11-19）：Windows 原生外壳（打开网站，单文件 exe）

用户 2026-11-19：「现在数据库都指向服务器了，windows环境还没改吗？macos环境已经改了」，问过之后选了「和 Mac 一样」；
打包之后又说「图标也要匹配」。这一轮做的就是 `docs/desktop-remote-plan.md` 第 5 步的第 1 步。

## 做了什么

**`deploy/desktop/windows-shell/`：C# + WinForms + WebView2 的外壳**，和 macOS 那份（Swift + WKWebView）同一个形状：
窗口里打开 `https://zhiqustudy.com`，包里不带 Java / JRE / JAR，也不需要 MySQL。

- **目标是 .NET Framework 4.8**，不是 .NET 8：Win10 / 11 自带 4.8，WebView2 运行时随 Edge 装，
  所以打出来是**一个 0.59MB 的 exe**，用户不用装任何运行时。.NET 8 自包含要多带 ~150MB，和「包里不带 Java」的理由正好相反。
- **单文件靠 Costura.Fody**（`FodyWeavers.xml`）：两个托管程序集和 `WebView2Loader.dll` 都嵌进 exe，
  原生 DLL 用 `costura64.<名字>` 的资源名；打包脚本会检查输出里真的没有剩下 dll，并试跑 3 秒确认起得来。
- **图标**：exe 资源图标（`ApplicationIcon`）+ 窗口图标（嵌进程序集的同一份 `zhiqu.ico`）。
  WinForms 的 `Form.Icon` 默认是它自带的彩色方块，不设的话「装的是知趣、打开是 WinForms 图标」。
- **打开哪个网站**：默认线上；`ZHIQU_DESKTOP_SERVER` 或注册表 `HKCU\Software\zhiqu\desktop` 的 `server` 指到别处。
  只认 https，http 只给本机，和 `Server.swift` 的规则一致。
- **窗口行为**：单实例（第二个进程把已有窗口叫到前面就退出）、记住大小和位置（`%LOCALAPPDATA%\zhiqu\window.ini`，
  丢屏校验）、站外链接交给系统浏览器、站内的 `target=_blank` 留在窗口里、`file://` 不交给系统、
  Ctrl+R / F5 重载、断网 / 5xx 说明 + 「重试」、启动前清 Service Worker 和它的缓存（否则断网时旧页面被当成载入成功）。
- **DPI**：单文件带不了 `.config`（WinForms 的 `DpiAwareness` 开关在 app.config 里），
  所以缩放自己问 `GetDpiForWindow`，窗口尺寸和字号都乘它 —— 125% 的屏幕上开出来是 1280×820 点。
- **`deploy/desktop/package-windows-native.ps1`**：`dotnet publish` → 改名 → 检查单文件 → 试跑。
- 老的那条路（`package-windows.ps1`，jpackage + 包里的 Java 后端 + 用户自己的 MySQL）留着备查，不再发版；
  顺手给它补了 UTF-8 BOM（Windows PowerShell 5.1 按 GBK 读无 BOM 的脚本，中文全是乱码、直接语法报错）。
- 安装包传上服务器：`data/downloads/知趣象限-1.5.5-win-x64.exe`（zhiqu:zhiqu 644），
  网页「下载桌面版」的 Windows 那一项就是它。

## 怎么验的

- 打包：`知趣象限-1.5.5-win-x64.exe` 622,080 字节；输出目录里没有 dll（Costura 生效）；试跑 3 秒进程还活着。
- 真窗口：`https://zhiqustudy.com/dashboard.html` 打开、能登录；窗口 1280×820（125% → 1600×1025 像素）。
- 图标：从 exe 里取出来的 256 图标和设计稿 `icon-1024.png` 缩放后一致；标题栏图标放大 8 倍看是同一个螺旋（不是 WinForms 的彩色方块）。
- 单实例：第二次双击后 4 秒内进程退出，窗口仍然只有一个。
- 窗口位置：关掉再开回到原处（`window.ini`）。
- 服务器：`GET /api/desktop/downloads/windows` → 200、622080 字节；下载回来算 sha256，和本地原件、接口里报的都一样。

## 还没做

- 本机代码助手（macOS 第 129–131 轮那套 zqLocal 桥）：Windows 桌面里的代码模式现在和网页一样只生成到产物。
- 系统通知、迷你番茄钟的悬浮胶囊、应用自更新（macOS 第一百三十二轮）。
- 没有代码签名，下载后 SmartScreen 会拦一下。

## 踩过的

- Windows PowerShell 5.1 读无 BOM 的 UTF-8 `.ps1` 按 ANSI（这台机器是 GBK）解，中文乱码、引号错位，报一堆「意外的标记」。
- `app.config` 里手写 `assemblyIdentity` 的 `publicKeyToken` 写短了就是 MSB3249「应用程序配置文件无效」，报错只指到那一行。
- `.NET Framework` 的 `Icon` 读 PNG 压缩的 ICO 没问题，但**窗口图标不会**从 exe 资源里自动拿。
- `CoreWebView2WebErrorStatus` 里没有 `InternetDisconnected` 这个成员（编译期才发现）。
- 从 DPI 不感知的 PowerShell 里用 `SetWindowPos` 挪一个 DPI 感知的窗口，坐标会被缩放，截图会错位 —— 验证时要么全程物理坐标，要么最大化整屏截。
