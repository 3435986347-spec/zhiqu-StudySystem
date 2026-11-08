# 第一百二十六轮（2026-11-09）：命令行 0.2.0（带子 agent）、桌面版断网说清楚、第一百二十五轮收尾

## 由来
用户两件：
1. 「查看项目最新一轮没有做完的做了」—— 第一百二十五轮还差：真窗口里点一遍、重打安装包放上服务器（用户 11-08 答过「打包、点一遍、再上传」）。
2. 「为什么现在不能开子agent，前面有一轮补上了」—— 贴了一段 agent 的回答：「不能。这个环境里没有开子 agent 的接口」。
   查明：用户终端里的 `zhiqu` 是 npm 上的 0.1.0（11-08 15:47 发布），子 agent 是 17:23 才提交的（第一百二十三轮），包里根本没有 `subagents.js`；
   服务器 `/api/harness/meta` 的 `cliLatest` 写死 0.1.0，旧版永远收不到「有新版本」。用户：「那就新发布」。

做的时候用户又说了三件：
- 第 7 步（停掉验证站、⌘R）时：「桌面版窗口还没有显示连不上」。
- 修 review 发现时：「子agent可以跑命令吧，这是之前订好的，但是他要等命令停下才能停止。」
- 「现在从网页上面下载安装包会很慢，只有50kb/s」；「优化现在ai助手里面的显示，要像codex那样把思考-run command- create -edit- ls 等等命令和结果给按顺序列出来」（排到第一百二十七轮）。

## 计划
1. 服务器说的命令行最新版本跟着打进 JAR 的那份 `zhiqu-cli/package.json` 走，不再写死；命令行升到 0.2.0。
2. 发布前 review 一遍 0.1.0 以来命令行的改动（子 agent 为主），真问题修掉、判据见红。
3. 桌面包重打（1.1.0），真窗口里点一遍（这个会话没有电脑操控：我开好、给清单，用户点）。
4. 三组判据全绿 → 提交 → 先发 npm、再部署网站 → 安装包放上服务器 → 桌面应用的 `defaults` 改回线上、停掉验证站。

## 做的时候查出来的
- **桌面版断网不说「连不上」**（用户在真窗口里停了验证站、按 ⌘R 照出来的）：页面装的 Service Worker 断网时拿缓存的页面顶上，WebKit 当成载入成功（`didFinish`、200），
  外壳收到 `onLoad(nil)`。第一百二十五轮的判据在不落盘、没有 Service Worker 的 WKWebView 里验的，照不出来。
  页面在桌面里不装（`maintainShellCache` 看到外壳的桥就不注册）；外壳启动时 `clearOfflineCache` 先清掉以前装上的（只清 Service Worker 和它的缓存，登录态在 localStorage 里不动），清完再开首页；
  没载入成时页面藏起来、只剩说明（原来说明压在一个点什么都没反应的旧页面上）。
  判据在真 WKWebView 里：对照组装上、不清，断网时必须是「载入成功」（复现）；清了的那组必须报错。同一个进程里 WebKit 的 Service Worker 进程还活着，报的是 `WebKitServiceWorker` 的错，真应用重开时是 -1004 —— 判据只认「是个错误」。
- **子 agent 起后台命令**（review）：第一百二十三轮说子 agent 不给后台命令，可只是参数里不提 —— 系统提示里写着「dev server 用 background: true」，模型照传，`executeTool` 只看 `args.background` 就起了，子 agent 停了它还占着端口、主 agent 不知道。
  用户定的：子 agent 能跑命令、能起后台命令，但要等命令停下才能停下。改成：子 agent 起的记在它名下，只看 / 停得了自己的（别人的 dev server 停不得）；
  要交结论时它的后台命令还在跑，先推一次「看完 / 停掉」；还不停，它停下之前（做完、`close_agent`、预算、一句话结束、Ctrl+C 都一样）连进程组一起停掉、等进程真没了，结论里说停了哪些。
  服务器上（没下发 `background`）模型照传也只当前台命令跑。
- **子 agent 停下后它的确认还挂着**（review）：`stop()` 只 abort，正问着的问题照样等人回答 —— 主 agent 收不了尾，按 y 也算不同意，接着打的下一句话被当成回答吃掉（第十三轮 Ctrl+C 修过同一种）。
  `Ui.choose` 认 `signal`：问的那一方停了，正问着的当场收起（留一行「不用回答了」），排着的轮到时不问。
- **部署早于 npm 发布**（review）：服务器的最新版本跟着打进去的 package.json 之后，先部署再发 npm，所有旧版每次启动都被提示去装一个装不到的版本。部署脚本第 0 步先 `npm view zhiqu@<版本>`，没有就停下（不编、不传），`SKIP_NPM_CHECK=1` 写明才跳过。
  判据真跑部署脚本（npm 是桩，mvn / ssh / rsync 一调就记下来）—— 第一次跑就红在 `CLI_VERSION：: unbound variable`：非 UTF-8 的 locale 下 bash 把全角冒号的字节并进了变量名。同样写法的另外两个脚本（`install-rag.sh`、`verify-hosted-shell.sh`）一起改成 `${…}`。
- **47615 连不上时教人换的命令对环境变量 / 项目设置无效**（review）：`zhiqu login --server` 只写用户配置，地址要是从 `ZHIQU_SERVER` 或项目的 `.zhiqu/settings.json` 来的，照着做下一次还是老地址。改成照来源说改哪一处（`serverSource`）。
- review 还说了预发布版本号（`0.3.0-beta.1`）会被 `compareVersions` 排错：这次是 0.2.0，没碰；以后发预发布版本之前要先改（旧版客户端的比较改不了，只能服务器不对外说预发布版本）。
- 第一百二十轮的 `shell-cache-check.js` 只抠了 `maintainShellCache`，它现在也调 `desktopBridge`：后端全量里红了一条，抠的时候一起带上。
- **下载慢**：服务器本机经 Caddy 下 dmg 290 MB/s、直连后端 366 MB/s，外面 ≈100 KB/s（页面脚本 35 KB/s）—— 瓶颈是公网带宽（约 1.5 Mbps，所有访问共用，第一百二十轮），不是后端 / Caddy。
  能做的：1.1.0 只有 42 MB（服务器上原来是 152 MB 的 1.0.0，带 Java），下载时间约四分之一。要快得花钱（升带宽 / 对象存储 + CDN / GitHub Releases），问用户。

## 结果
- `CliRelease`：`/api/harness/meta` 的 `cliLatest` 不配就是打进 JAR 的 `zhiqu-cli/package.json` 的版本；命令行 0.2.0。
- 桌面：`zhiqu-api.js`（桌面里不装 Service Worker）、`PageView.swift` 的 `clearOfflineCache`、`ZhiquShell.swift`（启动先清再开、没载入成藏页面）；缓存令牌 `20261109-r126a`；安装包 1.1.0（42 MB）。
- 命令行：`subagents.js`（`settle`、`ownJobs`、确认跟着停下收起）、`agent.js`（子 agent 有后台命令、只管自己的、交结论前推一次；没下发 background 不起后台命令）、`ui.js`（`choose` 认 `signal`）、`desktop.js` / `config.js`（`serverSource`、`switchHint`）。
- 部署：`deploy-from-dev.sh` 第 0 步看 npm。
- 判据：`CliVersionTest`、`HarnessMetaIntegrationTest`（真起后端走 `@Value`）；`DesktopPageViewTest`「断网时不拿缓存顶上」（真 WKWebView、对照组）、`DesktopPackagingTest`「启动先清离线缓存」、`DesktopNoServiceWorkerTest`（node 跑发布的那段，浏览器里照常注册是对照）；
  `subagents.test.js` 5 条（子 agent 能跑命令 / 只管自己的、交结论前推一次 / 停下时连进程组停掉、close / 一句话结束、确认当场收起 / 下一句不被吃掉、服务器上不起后台命令）；`desktop-launch.test.js` 1 条；`UbuntuDeployTest`「先发 npm 再部署」（真跑脚本，有对照）。
- 扰动：版本号 3 + 桌面 4 + 子 agent 7 + 部署 1 + 提示来源 1 = 16 个，全红。
- 三组：后端全量 1464（1 跳过写明原因）、命令行 493（475 过、18 跳：Linux 上的 bubblewrap）、评测工具 103（102 过、1 跳）。
- 真窗口（用户用鼠标点，指向本机验证站 + `zhiqu_verify`）：打开、登录、关掉再开还在、缩小到桌面（拖动 / 开始 / 展开）、下载弹窗（1.1.0、取消不报错）、外链、停掉验证站 ⌘R 显示「连不上」、起来后 ⌘R 回到看板。
- 发布 / 部署 / 上传：见下面「收口」。

## 收口
