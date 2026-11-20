# 第一百五十八轮（2026-11-19）：Windows 本机助手、通知、正式迷你胶囊与自更新

用户要求仿照 Mac 第 129–131 轮补 Windows 本机代码助手、系统通知、迷你番茄钟悬浮胶囊，并补应用自更新（Mac 第 132 轮），做完自己 review、修复。后续用户明确要求 Windows coding agent 必须能跑命令，并指出 Codex 有 Windows 沙箱、胶囊外观要一样。

## 实现

- **本机代码助手**：`BridgeScript` 注入与 Mac 同名的 `zqLocal` Promise 桥；只认外壳服务器 origin、只注入主文档，迷你窗没有本机桥。系统选文件夹持久保存，最多 20 个；磁盘根、家目录及其祖先不收。`LocalAgent` 起包里的官方 Node 跑同一份 `code-host.js`，服务器只认外壳地址；支持 trace/note、离页 resume/ack、say/say_ack、stop、会话记录与草稿 read/apply。宿主与外壳都脱敏令牌，快照不保存令牌、history 或文件夹请求。
- **Windows 命令**：用户选择的 auto / EXEC 档使用本机 `cmd.exe` 直接执行，不是系统沙箱。`plainLaunch` 用私有 UTF-8 `.cmd` 文件保留引号、中文、管道和退出码，正常结束清理；环境不继承令牌，Job Object 与 taskkill 收掉整个进程树。plan / manual 不直接执行任意 shell。模型提示和命令结果都明说“本机直接运行，不是系统沙箱”。这不冒充 Codex 的专用原生 runner / 沙箱。
- **通知**：持久 `NotifyIcon` 气泡与托盘菜单； authorize 对 unpackaged Win32 不弹无意义的网页授权；点击气泡、双击托盘都回主窗口。
- **迷你番茄钟**：300×68 DIP、TopMost、不进任务栏、不抢焦点；主窗和迷你窗共享 WebView2 Environment、Cookie 与 localStorage。加载发布版 `mini.html`、CSS 和 JS，圆环、按钮、圆角、透明、阴影不另画一套。原生拖动、展开和位置记忆。
- **自更新**：读现有 `/api/desktop/downloads` 的 `windows` 项；数字版本段比较，下载地址限制同 origin，大小与 SHA-256 都必须对。左下角胶囊：用户点了才下载，再点一次才重启；可跳过某个版本。启动检查、每 6 小时、激活时隔至少 1 小时。一次性 PowerShell 等主进程退出，同卷先复制 `.new`，再换 `.old` / 新 exe，失败恢复旧版，成功重启并清理。
- **打包**：官方 Node `22.23.2` Windows x64 ZIP 固定 SHA-256 `1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97`，LICENSE 一起进包；CLI `package.json` + `src/` 与 Node 组成嵌入 ZIP，首次运行按内容哈希释放。Costura 仍交付单 exe，不带 Java / MySQL。试跑使用本机假站、独立 profile 和独立实例，不开真实网站。
- **Windows 发布入口**：`deploy/ubuntu/deploy-from-windows.ps1` 用 Windows OpenSSH + PowerShell 替代 Mac 的 rsync 流程；编译后端、上传 CLI 与 exe、原子替换、重启并核对公网下载。首次没有私钥时生成用户级 key，系统 SSH 密码提示只用于登记公钥，密码不落盘、不进命令或日志。host key 用 OpenSSH `accept-new` 只在首次记录，已有主机的密钥变化仍拒绝。

## 自审与修复

- 路径解析在 Windows 根目录上曾把 `C:\` 变成 `C:`；权限句柄失败还曾静默退回未解析路径。改为保留根目录，解析失败不再当成安全路径。草稿补大小写重复名、DOS 设备名、ADS、尾随点/空格、大文件流式基线与确认幂等。
- 更新清单一开始误要求 URL 以 `.exe` 结尾，真实的 `/api/desktop/downloads/windows` 因而被忽略；检查程序先红后修。PowerShell 的 `$PID` 是只读自动变量，改成 `$OwnerPid`。
- 启动中的停止、重复 clientRunId、运行时释放异常留下“假运行”快照、快速退出事件登记、宿主回包异常都补了边界。真实 exe 还发现官方 Node 内 npm 路径可能超过传统 260 字符限制，安全校验后使用 `\\?\` 路径释放，交付级检查已覆盖。
- 迷你窗最初用 `TransparencyKey`：看得见，但鼠标穿透到桌面 `SysListView32`。真实鼠标测试没有移动；改为 DWM 透明背景后，命中 `Chrome_RenderWidgetHostHWND`，拖动实测位移 `(140,80)`，共享存储与展开都通过。
- 早期沙箱实验曾把 `SET_ACCESS` 误当 `DENY_ACCESS`，相关隔离判据被污染，不能据此宣称沙箱有效。另一条实验的窗口站清理误删了原有登录会话 ACE，导致新进程 `0xc0000142`；用户重启并运行恢复脚本后恢复。最终交付删除了全部窗口站、私有桌面和 AppContainer 实验代码，不保留这些全局权限修改。Windows 命令采用上面明确写出的直接执行边界。
- 更新辅助进程持有父进程标准句柄会锁住测试日志；切断继承，并在确认新进程启动后再清测试日志。Windows 部署首次生成 key 时，PowerShell 5.1 会丢 `-N ""` 的空口令参数；改为 .NET `ProcessStartInfo` 并用临时密钥实测成功。早期失败也写状态文件，重试会先测试已有私钥，避免把“文件已生成但公钥未登记”当成可用。

## 验证

- `zhiqu-cli/test/windows-direct.test.js`：3/3，无跳过（真 cmd、Node 表达式、中文、退出码、干净环境、临时文件清理、auto 门、完整 runHosted + 假网关）。
- `WindowsDesktopShellTest`：5/5，Failures 0 / Errors 0 / Skipped 0；真编译 C#，检查路径/草稿/更新清单、包内 Node 一轮、停止回收、坏 SHA 拒绝、真实替换与重启、WebView2 来源/iframe、通知桥、快照、正式胶囊外观、开始/暂停与真实鼠标拖动；另直接运行交付 exe，覆盖长路径下内嵌 Node 的自行释放与完整桥接。
- 打包产物：`build/desktop-windows-native/知趣象限-1.6.0-win-x64.exe`（36.6MB，SHA-256 `4bd37c371b9df3ee8459238af22fab499ccbe80ebb53ad8a8ce219dcc75a5ce0`）。正式胶囊截图：`build/shots/windows-mini-pomodoro.png`。
- 命令行全量：`679` 项，`578` 过、`45` 失败、`56` 跳过；基线为 `47` 个失败，本次没有新增失败名称。失败集中在原有 Windows 软链、Unix 进程/路径、截图等兼容假设，不能称为全量通过。
- 后端 Docker 全量 `mvn -o clean test`：`1555` 项，`57 Failures + 18 Errors`，24 跳过；其中 Windows 外壳 5/5、`ClaudeMdTest` 5/5。`JsCodeAgentTest` 的资源比较因全量运行期间改了宿主注释而红，停止改动后单独 12/12 通过。剩余失败是已有的 Windows/Unix 路径、进程、软链、文件权限与前端旧判据问题，不称为全量通过。

## 边界

- Windows auto 档的直接命令能访问当前用户有权限的文件和网络，**没有 Mac Seatbelt / Codex 原生沙箱的隔离强度**；这不是隐藏降级，协议和模型提示都明确标记。后续若补 Codex 同类沙箱，应使用验证过的原生 runner 与安装/权限模型，不再临时修改用户桌面或全局权限。
- 没有代码签名，SmartScreen 可能提示。未部署服务器、未使用真实账号。通知桥用收集桩验证，未人工点击 Windows 通知中心里的历史通知。
- 前端发布文件没有修改，不需要换静态缓存令牌。
