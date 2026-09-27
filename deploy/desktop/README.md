# 桌面应用形态

双击启动的应用，后端装在里面。**数据不在应用里** —— 指向哪个数据库就存在哪里，
所以换台机器装同一个应用、登录同一个账号，看到的是同一份数据。

## 为什么后端必须装在应用里，而不能只做一个指向服务器的窗口

代码工作区（coding agent 读你磁盘上的项目）有一条硬前置：`server.address` 必须是回环地址。
一个能读你硬盘的服务不能监听公网。

所以：

| 能力 | 桌面应用 | 远程服务器上的那一份 |
|---|---|---|
| 四象限 / 任务 / 统计 / 成就 | ✓ | ✓ |
| AI 助手 / 知识 Wiki | ✓ | ✓ |
| **代码工作区 / 刷题 / 项目引导** | ✓ | **✗（设计如此）** |

服务器上没有你的代码，而且多用户实例里谁都不该读到它的磁盘。这不是待补的功能。

## 打包

**macOS —— 原生应用（推荐）**：Swift + WKWebView 外壳，无边框窗口铺满，不弹浏览器、不弹跳
Dock 图标、带「知」字图标。产出 `.app` 和拖拽安装的 `.dmg`（约 126MB / 103MB）。

```bash
deploy/desktop/package-macos-native.sh          # → build/desktop-native/{知趣象限.app, 知趣象限-1.0.0.dmg}
deploy/desktop/package-macos-native.sh 1.2.0
```

**Windows —— `.exe`**：只能在 Windows 上打（jpackage 不做跨平台，macOS 上打不出 .exe）。
在那台 Windows 机器上，装好 JDK 17（Temurin）并设好 `JAVA_HOME`，然后：

```powershell
cd deploy\desktop
.\package-windows.ps1            # 版本默认 1.0.0
```

第一次打包会联网下载 Maven 依赖（之后走本地缓存）；`mvn` 或 `jpackage` 任何一步失败，脚本会带着退出码停下，
不会打印「完成」。内置的 Java 运行时用 jpackage 的默认模块集（已实测包含 `jdk.charsets` 与 `jdk.crypto.ec`，
不会出现 macOS 版踩过的中文乱码 / HTTPS 握手失败），所以比 macOS 版大一些（运行时约 130MB）。

装了 WiX Toolset 就出单文件安装程序 `知趣象限-1.0.0.exe`；没装则出一个免安装目录，
里面的 `知趣象限.exe` 双击即运行。Windows 版双击后在**默认浏览器**里打开界面 —— 要做成
和 macOS 一样的无边框原生窗口需要 WebView2 外壳（C#），单独做。固定端口（记住登录）、
headless、图标这些修复 Windows 版都有。

## 命令行 `zhiqu`（macOS）

应用包里带着一个命令行入口，连的就是应用里那个后端 —— 同一个库、同一个账号、同一条 agent 流水线。
在任意项目文件夹里敲 `zhiqu`，就是一个直接能用的 coding agent：

```bash
ln -s "/Applications/知趣象限.app/Contents/Resources/bin/zhiqu" /opt/homebrew/bin/zhiqu   # Intel Mac 用 /usr/local/bin
cd ~/Developer/我的项目
zhiqu                      # 第一次会问用户名和密码，之后 30 天免登录
zhiqu -p "解释一下 main.py" # 只问一句就退出
zhiqu --mode exec          # 允许它运行工作区里的文件
zhiqu stop                 # 停掉由 zhiqu 在后台启动的后端
```

- 当前文件夹就是工作区（网页里的工作区也会跟着切过去）。在 `/` 或家目录下运行会被拒绝 ——
  那等于把所有文件交给 agent；真要这样加 `--allow-broad-root`。
- 每一步都会打出来：读了哪个文件、生成了哪个文件的草稿、跑了什么命令、输出是什么。
- 改文件先出 **diff**，你按 `y` 才写到磁盘上；`n` 丢弃，直接回车先放着（`/drafts` 或网页里再处理）。
  同一轮里「写完立刻跑」做不到，这是刻意的：执行只跑磁盘上已经存在、你看过的文件。
- 应用没开也能用：`zhiqu` 会在后台把后端拉起来（日志 `~/.zhiqu/logs/backend-cli.log`），
  之后再打开应用会直接连上它。终端里按 Ctrl+C 或关掉终端都不会把后端带走。
- 对话记在名为「命令行」的 Notebook 里，网页里切过去也能看到。
- 上面这个是随应用打包的 Java 版（bash 启动脚本，只有 macOS）。**Windows 上用 npm 版 `zhiqu`**：
  装好 Node 22，`cd zhiqu-cli && npm link`，它默认连的就是本机桌面应用（`http://127.0.0.1:47615`）。
  npm 版是现在的主力版本（循环和工具在你电脑上跑），Java 版只是还留在应用包里。

## 用户配置：`~/.zhiqu/application.yml`

应用启动时会读这个文件（有就读，没有就跳过），它的优先级高于打包进去的默认值。
**改这里不需要重新打包。**

```yaml
spring:
  datasource:
    # 指向远程 MySQL 就能多地点登录看同一份数据。
    # 见下面「不要把 MySQL 开到公网」。
    url: jdbc:mysql://127.0.0.1:13306/zhiqu_db?useUnicode=true&characterEncoding=utf-8&serverTimezone=Asia/Shanghai
    username: zhiqu
    password: 你的密码

app:
  workspace:
    # 默认 OFF。要用 coding agent 才打开。
    #   READ  只读代码    WRITE 允许草稿落盘    EXEC 允许跑命令
    mode: READ
    root: /Users/你的用户名/Developer/你的项目
```

工作区还有两个前置（缺一就自动降级到 OFF，界面上会说明原因）：`root` 指向的目录要存在，
以及当前账号是管理员。单机自用时把自己提成管理员是一次性动作。

## 不要把 MySQL 直接开到公网

要多地点登录，数据库得能被各处的桌面端连上。**但 3306 开在公网会被扫到。**
正经做法二选一：

- **SSH 隧道**：`ssh -N -L 13306:127.0.0.1:3306 你@服务器`，配置里连 `127.0.0.1:13306`
- **WireGuard / Tailscale**：数据库只监听内网地址，桌面端在同一个虚拟网里

服务器那边 MySQL 应当 `bind-address = 127.0.0.1`，不要为了图方便改成 `0.0.0.0`。

## 已知现状

- macOS 版是原生窗口（Swift + WKWebView）；**Windows 版仍在默认浏览器里打开**，
  原生窗口要 WebView2 外壳，单独做。
- 应用**不含数据库**。第一次用要先有一个可连的 MySQL（本机或远程）。
- 端口固定为 **47615**（不是 8080，也不是随机）：「记住登录」要求 origin 稳定，
  而浏览器 / WebView 的本地存储按端口隔离。被占用时原生外壳会连到已有实例。
- 桌面应用的工作目录是 `/`，所以上传目录都配成了 `~/.zhiqu/` 下的绝对路径
  （`application-desktop.yml`）—— 相对路径会指向只读的根目录，上传全部失败。
