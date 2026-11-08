# 第一百二十五轮（2026-11-08）：Mac 桌面版打开网站、包里不带 Java（桌面版改架构第 1 + 4 步）

## 由来
用户：「桌面版的mysql应该也要连服务器上的」，问过之后定了给所有下载的人用。直接连服务器的库就得把主密钥发给每个人（能解全站的数据），
所以出了方案（`docs/desktop-remote-plan.md`），用户定了 A：窗口里打开网站、本机代码交给包里的 node；本机库旧数据不要了；断网看不了可以；Windows 也做原生窗口（排在后面）。

## 计划
1. 外壳打开网站（默认 `https://zhiqustudy.com`，能改）：登录、迷你番茄钟、下载、外链这些外壳功能接上网站；不再起 Java 后端。
2. 方案第 4 步（去掉包里的 Java 后端和 JRE）合进这一轮：外壳不起 Java 之后，包里的 JRE 和 JAR 就是死的 —— 几十 MB、每次打包多跑一遍 Maven 和 jlink，还让人以为桌面版有一个本机后端。分两轮做只会多出一个「带着死 JRE」的中间包。
3. 页面从服务器来、里面有 AI 写的和导入的内容：外壳的门跟着收紧（桥只认自己网站、链接按服务器主机分里外）。
4. 连不上（断网、服务器在重启）要说清楚、能重来。
5. 判据在真的 WKWebView 里验；扰动看红。
6. 真应用里用鼠标走一遍 —— 要开窗口，先问用户；验证时指到本机后端 + `zhiqu_verify` 库，不碰线上的真账号。

## 做的时候多出来的
- **AI 生成的 HTML 预览能用外壳的桥**：预览是 sandbox 的 srcdoc iframe，`window.webkit.messageHandlers` 在每个框里都看得见 —— 一段生成的网页就能弹通知、把主窗口缩没。桥只认自己网站的主框架。
- **框里的脚本一句 `location.href` 就叫起系统浏览器**：原来所有不是本机的导航都交给系统。框里不是人点的跳转就地拦下。
- **`target=_blank` 的任何地址都交给 `NSWorkspace.open`**：`file:///…/某某.app` 就是运行它。交给系统的只剩 http / https / mailto。
- **命令行连 47615 被拒时替人打开桌面应用、等 40 秒**（第十二轮）：新的 Mac 桌面应用不在本机跑后端，只会白等、最后说「还没起来」。改成直接说清楚、给出 `zhiqu login --server https://zhiqustudy.com`。
- **下载弹窗写着「桌面版自带后端，要连一个 MySQL」**：Mac 版改成「打开的就是这个网站」，MySQL 那句只留给 Windows 版。
- **实现了回应策略就得自己管显示不了的类型**：为了看 5xx 加了 `decidePolicyFor navigationResponse`，第一版一律放行 —— 打开一个 zip，WebKit 报「因策略改变中断」（102），外壳会盖上「连不上」。主框架的转成下载、框里的不理，那一次 102 不算。
- **转成的下载在保存面板里点取消，提示「没有保存成功」**：页面上 `a[download]` 的下载取消了不走 `didFailWithError`，这种走。记下用户取消的那几个。
- **判据跑着跑着，系统的提示框弹到了用户屏幕上**（用户：「好像是磁盘满了」）：检查程序里新建的那个页面漏了把 `reportFailure` 换成桩，默认的是 `NSAlert.runModal`。补上桩，并且把「取消不算失败」变成一条判据（基线里就报了一次 —— 上一条就是这样发现的）。

## 结果

- 外壳：`Server.swift`（打开哪个网站：默认 `https://zhiqustudy.com`，`ZHIQU_DESKTOP_SERVER` 或 `defaults write com.zhiqu.quadrant server …` 能改；只认 https、http 只给本机；只要协议 + 主机 + 端口、主机名小写），`ZhiquShell.swift` 不再起后端（`Backend`、端口文件、JVM 参数、退出时停后端都去掉），主窗口和迷你窗打开 `Server.page(...)`、只认服务器那一个主机；「正在连接」载入完了收起、没载入成说清楚、⌘R 重来；`CdsCache.swift` 删掉。
- `PageView.swift`：桥只认自己网站的主框架；链接按 `allowedHosts` 分里外（不是本机的只认 https）；框里不是人点的跳转就地拦下；交给系统的只有 http / https / mailto；载入结果（完了、5xx、连不上；-999、转下载的 102 不算）告诉外壳；显示不了的类型主框架转下载、框里的不理；取消下载不算失败；菜单「显示 → 重新载入」。
- 打包脚本：不打 JAR、不跑 jlink、不放 runtime，五步（骨架 + node、图标、外壳、签名、dmg），编进 `Server.swift`。node 留给第 2 步。
- 命令行：连 47615 被拒（Mac）不再替人打开应用、等 40 秒，直接说「桌面应用打开的就是网站」并给出 `zhiqu login --server https://zhiqustudy.com`（默认服务器还是本机时不说这句）。
- 下载弹窗：Mac 版「打开的就是这个网站：同一个账号同一份数据，断网时看不了」；MySQL 那句只说 Windows 版。缓存令牌 `20261108-r125a`。
- 判据：`DesktopPageViewTest` 的检查程序起一个本机小 HTTP 服务器（`NWListener`：200 / 502 / 慢回包 / zip），在真的 WKWebView 里验桥的来源（两个框：sandbox 的、`allow-same-origin` 的；名单外来源的主框架）、链接分里外、`file://` 两条路、载入结果、被顶掉的导航、转下载、取消不算失败、服务器地址 15 种写法、菜单。检查程序编一次跑一次、各条共用（11 条 25 秒）。`DesktopPackagingTest` 换成「包里不带 Java」「外壳打开网站」；钉 jlink 模块、headless、端口文件、CDS 启动加速的五条和 `DesktopCdsCacheTest` 随代码去掉（jdk.charsets 那段经过留在 `docs/notes/desktop.md`）。命令行 4 条、下载弹窗 2 条。
- 扰动：34 + 6 + 3 + 8 + 1 = 52 个。第一批「桥不看来源」那个设计错了（同时放宽了两道），另跑「只看主框架」—— 红在「名单外来源的主框架」那条，正是它独有的样本；「主窗口打开别页」第一次是绿的：「重新载入」里也有同一句，`contains` 被它满足 —— 打开首页收成 `openHome()` 一处，判据认启动时调的是它，再扰动红了。其余全红。
- 真窗口里点一遍、重打安装包放上服务器：要开窗口 / 动服务器，先问用户。验证时不让它打开线上网站（那是用户的真账号）：`defaults write com.zhiqu.quadrant server http://127.0.0.1:18080` + `zhiqu_verify` 库。
