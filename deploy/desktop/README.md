# 桌面应用形态

**macOS**（第一百二十五轮起）：一个原生窗口（Swift + WKWebView），里面打开的就是网站 `https://zhiqustudy.com`。
数据只在服务器上：和网页版用同一个账号登录，就是同一份数据；断网时看不了（用户 2026-11-08 定的，见 `docs/desktop-remote-plan.md`）。
包里不带 Java、JRE，也不需要 MySQL。比网页多的：系统通知、缩到桌面上的迷你番茄钟、文件选择和下载走系统的面板。

**Windows** 现在还是老样子：包里带一个完整的后端（jpackage），连一个 MySQL，在默认浏览器里打开。原生窗口（WebView2）排在 macOS 的几步之后。

## 本机代码

代码模式读写你磁盘上的项目、在系统沙箱里跑命令 —— 这件事不能交给服务器（服务器上没有你的代码，多用户的机器也不该读谁的磁盘）。
Mac 版下一步由包里的 node 跑命令行那一份（「本机代码助手」，方案第 2、3 步）；在那之前，桌面版的代码模式和网页一样只生成到产物。
现在要在本机项目上用，用命令行 `zhiqu`（下面）。

## 打包

**macOS —— 原生应用**：Swift + WKWebView 外壳，无边框窗口铺满，带应用图标（设计稿在 `assets/icons/`，`deploy/desktop/icon/MakeIcon.swift` 做成 iconset 和 ICO）。
产出 `.app` 和拖拽安装的 `.dmg`。

```bash
deploy/desktop/package-macos-native.sh          # → build/desktop-native/{知趣象限.app, 知趣象限-1.0.0.dmg}
deploy/desktop/package-macos-native.sh 1.2.0
```

打开哪个网站：默认 `https://zhiqustudy.com`。开发时指到本机的后端（只认 https，http 只给本机）：

```bash
defaults write com.zhiqu.quadrant server http://127.0.0.1:18080
```

改回去：`defaults delete com.zhiqu.quadrant server`。也可以用环境变量 `ZHIQU_DESKTOP_SERVER`（从终端起应用时）。
连不上（断网、服务器在重启）时窗口里会说，联网后按 ⌘R（「显示 → 重新载入」）。

包里还带着 Node（给本机代码助手）。macOS 打包默认从 [Node 官方发行目录](https://nodejs.org/dist/v22.23.2/) 准备 **Node 22.23.2 / ARM64**，
按脚本里固定的 SHA256 校验，缓存到 `build/node-runtime/`；第一次需要能访问 `nodejs.org`，之后可离线复用。
应用内只带 Node 运行时与 LICENSE，不需要用户另装 Node 或 Homebrew。

离线首次打包可把官方 `node-v22.23.2-darwin-arm64.tar.gz` 放进 `build/node-runtime/`，
或解压官方 macOS ARM64 发行包后指定：

```bash
NODE_BIN=/绝对路径/node-v22.23.2-darwin-arm64/bin/node bash deploy/desktop/package-macos-native.sh
```

`NODE_BIN` 需要 Node ≥ 18.17、ARM64、兼容 macOS 13.0，只依赖系统动态库，并保留发行包里的 `LICENSE`。
不要直接指定 `/opt/homebrew/bin/node`：某些 Homebrew 版本依赖 `libnode`、OpenSSL、ICU 等外部库，
复制一个文件进应用后会报 `Library not loaded`。脚本会在清理旧包之前拒绝这种运行时。
准备下载失败或校验失败会停止，不会退回使用 PATH 上的 Node。

> 第一百二十五轮之前包里还有瘦 JAR + jlink 裁的 JRE + 启动加速的类归档（`~/.zhiqu/app`、`~/.zhiqu/cds`，共约 160MB）。
> 装过旧版的，这两个目录可以删掉；`~/.zhiqu/application.yml`、本机的 MySQL 新版都不读了（旧数据用户定了不要，库留着不动）。

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

## 命令行 `zhiqu`

命令行是 npm 版（仓库里的 `zhiqu-cli/`）：循环和工具在你电脑上跑，默认连 `https://zhiqustudy.com`（2026-11-08 起），和 Mac 桌面应用同一个网站、同一份数据。
连本机的 Windows 桌面应用（还带着后端）：`zhiqu login --server http://127.0.0.1:47615`。Mac 上连 47615 被拒时命令行直接说「桌面应用打开的就是网站」、给出换过去的命令（原来会替你打开应用、等它起来）。
`npm install -g zhiqu`，或者在仓库里 `cd zhiqu-cli && npm link`；macOS 和 Windows 一样。用法见 `zhiqu-cli/README.md`。

> 应用包里原来带着一个 Java 版的 `zhiqu`（`Contents/Resources/bin/zhiqu`），2026-10-04 删除了。
> 以前照着这里建过软链的，删掉它：`rm /opt/homebrew/bin/zhiqu`（Intel Mac 是 `/usr/local/bin/zhiqu`），再按上面装 npm 版。

## Windows 版的用户配置：`~/.zhiqu/application.yml`

（Mac 版第一百二十五轮起不读它了。）Windows 版应用启动时会读这个文件（有就读，没有就跳过），它的优先级高于打包进去的默认值。
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
  crypto:
    # 连服务器上的库时必填，而且必须和服务器 application-prod.yml 里的 app.crypto.master-key 一字不差。
    # 不配的话用的是仓库里的开发默认值：它解不开服务器写的数据，它写进去的服务器也解不开 ——
    # 所以主密钥对不上时应用不启动（见下面「几个后端连同一个库」）。
    master-key: 和服务器一样的那一串
  workspace:
    # 默认 OFF。要用 coding agent 才打开。
    #   READ  只读代码    WRITE 允许草稿落盘    EXEC 允许跑命令
    mode: READ
    root: /Users/你的用户名/Developer/你的项目
```

工作区还有两个前置（缺一就自动降级到 OFF，界面上会说明原因）：`root` 指向的目录要存在，
以及当前账号是管理员。单机自用时把自己提成管理员是一次性动作。

## 几个后端连同一个库

Windows 版桌面应用里装着一个完整的后端（Mac 版第一百二十五轮之前也是）。服务器上一个、每台开着桌面应用的电脑上各一个，都连同一个 MySQL 时（第二十八轮）：

- **加密主密钥必须是同一把。** 任务标题、Wiki 正文、模型 Key 是用它加密存的。启动时会用本机的主密钥去解库里的一个哨兵
  （`crypto_canary`）；解不开就不启动，日志里写着原因 —— 宁可起不来，也不往共享的库里写别人解不开的数据。
  库里还没有哨兵时先抽查已有的密文，一格都解不开同样不启动、也不写哨兵。
- **正在生成的回答不会被别的实例「收拾」掉**：进行中的回答每 30 秒在库里留一次心跳，只有心跳停了 3 分钟以上的才算中断。
- **早上 8 点的汇报只发一次**：哪个实例先在库里认领了那一天，哪个发。
- 每个实例的登录令牌各签各的（`jwt.secret` 不必一样）：在桌面应用里登录的只对桌面应用有效。

## 不要把 MySQL 直接开到公网

要多地点登录，数据库得能被各处的桌面端连上。**但 3306 开在公网会被扫到。**
正经做法二选一：

- **SSH 隧道**：`ssh -N -L 13306:127.0.0.1:3306 你@服务器`，配置里连 `127.0.0.1:13306`
- **WireGuard / Tailscale**：数据库只监听内网地址，桌面端在同一个虚拟网里

服务器那边 MySQL 应当 `bind-address = 127.0.0.1`，不要为了图方便改成 `0.0.0.0`。

## 已知现状

- macOS 版是原生窗口（Swift + WKWebView），打开网站；**Windows 版仍在默认浏览器里打开**，原生窗口要 WebView2 外壳，单独做。
- Mac 版断网时看不了数据（和网页一样）；本机代码要等本机代码助手（方案第 2、3 步），在那之前用命令行。
- Windows 版**不含数据库**：第一次用要先有一个可连的 MySQL（本机或远程）。端口固定为 **47615**（不是 8080，也不是随机）：
  「记住登录」要求 origin 稳定，而浏览器的本地存储按端口隔离。
- 带后端的桌面版（现在只有 Windows 版）的上传目录都配成了 `~/.zhiqu/` 下的绝对路径（`application-desktop.yml`）：
  macOS 旧版从 Finder / Dock 启动时工作目录是 `/`，相对路径指向只读的根目录，上传全部失败。
