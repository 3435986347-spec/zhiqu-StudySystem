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

> `deploy/desktop/package-macos.sh` 是旧的 jpackage 版，双击后**弹系统浏览器**。留着做对照，
> 新分发用上面那个原生版。

**Windows —— `.exe`**：只能在 Windows 上打（jpackage 不做跨平台，macOS 上打不出 .exe）。
在那台 Windows 机器上，装好 JDK 17（Temurin）并设好 `JAVA_HOME`，然后：

```powershell
cd deploy\desktop
.\package-windows.ps1            # 版本默认 1.0.0
```

装了 WiX Toolset 就出单文件安装程序 `知趣象限-1.0.0.exe`；没装则出一个免安装目录，
里面的 `知趣象限.exe` 双击即运行。Windows 版双击后在**默认浏览器**里打开界面 —— 要做成
和 macOS 一样的无边框原生窗口需要 WebView2 外壳（C#），单独做。固定端口（记住登录）、
headless、图标这些修复 Windows 版都有。

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

- 界面在**默认浏览器**里打开，不是内嵌窗口。你会得到真正的应用图标和双击启动，
  但观感上还是网页。完全脱离浏览器需要内嵌 WebView（JavaFX），每个平台各加约 60MB。
- 应用**不含数据库**。第一次用要先有一个可连的 MySQL（本机或远程）。
- 端口由系统分配，不固定 8080 —— 固定端口在别的服务占着时会直接启动失败，
  而那对双击启动的人是一句看不懂的报错。
