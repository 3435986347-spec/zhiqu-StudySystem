# 第五十一轮（2026-10-09）：迷你番茄钟第 3 步 —— macOS 外壳的悬浮面板

## 由来
`docs/mini-pomodoro-plan.md` 第 3 步（用户 2026-10-09 定了：只做 macOS 桌面应用；番茄钟卡片上「缩小到桌面」进入、迷你窗上「展开」回来、最小化时不自动变；半透明的深色胶囊）。
第 1 步（第四十九轮）番茄钟全站一个钟；第 2 步（第五十轮）`mini.html` 胶囊页面、「展开」已经会发 `zqMini` 的 `{action:'expand'}`。

## 计划
1. **外壳的悬浮面板**（`ZhiquShell.swift`）：一个 `NSPanel` —— 无边框、透明（只露出页面里的胶囊）、不抢焦点（`.nonactivatingPanel`）、总在最前（`.floating`）、
   所有桌面空间和全屏应用旁边都在、主窗口藏起来时也不跟着藏；里面一个 `PageView` 打开 `mini.html`（同一份网站数据：同一个登录、同一个钟）。
   记住位置（`setFrameAutosaveName`），第一次出现在屏幕右上角。
2. **拖动**：WKWebView 把鼠标事件全吃了，`isMovableByWindowBackground` 对它不起作用（主窗口顶上那条 `DragStrip` 就是为这个）——
   胶囊中间（时间和小字那一块，没有能点的东西）盖一块透明的可拖区域，两边的按钮照常点得到。
3. **进出**：`PageView` 多接一座桥 `zqMini`：`{action:'shrink'}`（主窗口的看板上点「缩小到桌面」）→ 主窗口藏起来、面板出来；
   `{action:'expand'}`（迷你窗上点「展开」）→ 面板收起、主窗口回来并到最前。点 Dock 图标也回到主窗口。别的消息一律不理（页面内容不可信）。
4. **看板**：番茄钟卡片上一个「缩小到桌面」按钮，只在桌面应用里出现（看得到 `zqMini` 这座桥才显示）。
5. **判据**：`page-view-check.swift`（真 WKWebView）加：`zqMini` 只认那两种消息、交给外壳的回调；两个 `PageView` 共用一份网站数据时 localStorage 看得到彼此（迷你窗和主窗口同一个钟）。
   面板的设定（层级、不抢焦点、所有空间、透明）拆成一个函数在检查程序里建出来核对，不弹到屏幕上。看板的按钮只在有桥时出现（node）。扰动见红。
6. 重新打包桌面应用。面板要在屏幕上开出来才看得到、截得到 —— **跑之前问用户**（CLAUDE.md：不要擅自启动桌面应用去碰用户的真实数据；用户说过预览不要弹窗口）。

## 结果（2026-10-09）

照计划做完；面板没在屏幕上开过（等用户定）。

- **`MiniPanel.swift`**（新）：`makeMiniPanel(page:)` 建一个 300×68 的 `NSPanel` —— 无边框、透明、不要窗口影子（胶囊的影子页面自己画，窗口的影子是方的）、`.nonactivatingPanel`、`.floating`、
  `canJoinAllSpaces` + `fullScreenAuxiliary`、`hidesOnDeactivate = false`、`canBecomeKey` 覆写成 true（键盘按得到胶囊上的按钮）、记位置（`ZhiquMiniPanel`，第一次在主屏幕右上角）。
  胶囊中间盖一块 `MiniDragZone` 拖动（WKWebView 吃掉鼠标事件，`isMovableByWindowBackground` 对它不起作用），两边的按钮不盖。
- **`PageView`**：多一座桥 `zqMini`，只认 `shrink` / `expand`，交给外壳的 `onMini`；消息分派改成按（桥，动作）一个 `switch` —— 原来 `zqMini` 分支后面的 `return` 和 `zqNotify` 的 guard 挡的是同一件事，
  一道防护被另一道替着、照不出来（判据纪律第 6 条），合成一处。检查程序要两个页面共用一份网站数据，`init` 多一个只给检查用的 `dataStore`。
- **外壳**（`ZhiquShell.swift`）：缩小 → 主窗口 `orderOut`、面板 `orderFrontRegardless`（第一次才建，里面的 `mini.html` 一直开着）；展开 / 点 Dock 图标 / 点通知 / 迷你模式下 Cmd+Tab 切回来 → 面板收起、主窗口回来。
  Cmd+Tab 那一条是做的时候想到的：主窗口藏着时切回应用，原来什么窗口都没有（Dock 图标的 `applicationShouldHandleReopen` 管不到 Cmd+Tab）；胶囊本身不会让应用到前台，所以应用到了前台一定是人特意切过来的。
- **看板**：番茄钟卡片上「开始 / 重置」旁边一个「缩小到桌面」，只在看得到 `zqMini` 这座桥时出现（浏览器里没有）；外壳不在了点它会说出来。壳多给模块一个 `miniBridge`（胶囊的「展开」也改用它）。
- **实测（检查程序里两个共用一份网站数据的 WKWebView）**：localStorage 互相读得到；`navigator.locks` 是同一把（到点只响一次靠它）；**storage 事件不在两个 WKWebView 之间传**（放进窗口里也不传）——
  页面本来就不靠它（一秒一跳、`visibilitychange`），判据只要求读得到、锁是同一把，storage 事件只记下来。
- 顺手：第四十九轮给侧栏那一行写的 `.zq-side-pomo[hidden]{display:none;}` 是多余的（全局有一条带 `!important` 的 `[hidden]`），注释也说错了 —— 删掉、改注释。

**判据**：`DesktopPageViewTest` 加两条 —— 「迷你番茄钟」（检查程序里真发 `zqMini` 消息、两个页面共用网站数据、建面板核对设定 / 点得到按钮 / 拖得动）、「外壳接上迷你窗」（外壳源码的接线）；
`pomo-card-check.js` 加「缩小到桌面」只在有桥时出现、点了发 shrink、外壳不在了说出来。扰动 23 个全红：zqMini 认任何动作、zqMini 的消息串到通知、不注册 zqMini、面板不总在最前、抢焦点、换空间就不见、
不透明、方的影子、后台就藏、当不了键窗口、不记位置、拖不动、拖动盖住按钮、展开主窗口不回、点 Dock 不回、Cmd+Tab 不回、点通知不收胶囊、主窗口不接、缩小时主窗口不藏、打包不编 MiniPanel、
浏览器里也出缩小按钮、缩小失败不说、`miniBridge` 没给模块。

**暴力测试**：面板这一轮没在屏幕上开（要用户点头）；浏览器这一侧：看板上「缩小到桌面」在浏览器里不出现（`hidden`、`display:none`），手动亮出来时「开始 / 重置 / 缩小到桌面」一行放得下；
胶囊页的「展开」在浏览器里去看板（桥换成壳的 `miniBridge` 之后照常）。

**验**：全量 1015，唯一一条红是 `ClaudeMdTest`（这一行还没加）—— 加上后那一条绿；桌面应用重新打包（外壳改了：`MiniPanel.swift` 编进去了）。
用户要看面板浮在桌面上的样子：打开 `build/desktop-native/知趣象限.app`，看板的番茄钟卡片上点「缩小到桌面」—— 或者让我开（会连用户自己的数据库，先问）。
