# 第一百二十九轮（2026-11-11）：桌面版本机代码助手（方案第 2 步）

## 由来
用户 2026-11-09：桌面应用里没有「选文件夹作为工作区」—— 第一百二十五轮起 Mac 桌面版窗口里打开的是网站，代码模式跑在服务器上，碰不到本机的项目。
网页版不能选是对的，应用版要能选。这就是 [`docs/desktop-remote-plan.md`](../desktop-remote-plan.md) 的第 2、3 步（方案 A，用户 2026-11-08 定的）。
用户 11-09 说「好的」同意顺序（第一百二十八轮修完回答和步骤对不上，之后两三轮做这个），11-11 在新会话卡片上点了「在这里做」。

这一轮是第 2 步：**外壳按需起包里的 node 跑命令行的宿主；登录用页面的登录换一张只给本机代码用的令牌；模型走服务器网关**。
页面在桌面里走这座桥（选文件夹的按钮、档位、代码模式的一轮、确认草稿写盘、`/review` `/init`）是第 3 步，下一轮之后做。

## 现状（开工时读代码）
- 外壳（`deploy/desktop/macos-shell/`）只打开网站：通知、迷你番茄钟、文件选择、下载。包里有 node（`Resources/node/bin/node`），没人用。
- 宿主 `zhiqu-cli/src/host/code-host.js` 是后端（`JsCodeAgent`）起的：模型（`model`）、命令（`exec`）、远程工具（`tool`）都经 stdin / stdout 回给后端做，
  宿主里只有循环、工作区的读和草稿（`DraftTools`）。
- 命令行 `zhiqu` 的样子正是桌面要的：循环和工具在本机，模型、登录、数据在服务器（`/api/harness/**`，个人访问令牌 `zqp_…`）。
- 个人访问令牌表早就有 `scope`、`expires_at` 两列，但只有一种（`HARNESS`），从不过期，整个 `/api/harness/**` 都认。

## 怎么做
1. **服务器：只给本机代码用的令牌**
   - `POST /api/access-tokens/desktop-code`：只认网页的登录态（和管理令牌的接口一样不在 `/api/harness/` 下，一张泄露的令牌给自己续不了命）。
     签一张 `scope = DESKTOP_CODE`、12 小时过期的令牌，明文只在这次响应里出现一次。
   - 这种令牌只在四个接口被认（`HarnessPaths` 一处判）：`GET /api/harness/models`、`POST /api/harness/model/stream`、`GET /api/harness/tools`、`POST /api/harness/tools/call`。
     会话存档、用量、`/me`、改上下文窗口这些都不认 —— 本机代码助手用不到，泄露了也只是「有人能用你的模型额度 12 小时」。
   - 令牌列表不列已经过期的（不然每次开应用都多一行）。
2. **宿主：桌面这一份（`code-host.js` 的本机模式）**
   - `run.local = { server, token }`：模型、模型列表、远程工具直接走服务器网关（命令行的 `Api`，和命令行同一份）；不再往 stdout 要 `model` / `exec` / `tool`。
   - 工具 `DesktopTools`：写（`write_file` / `edit_file` / `apply_patch`）照旧只成草稿、不落盘（「AI 写的东西一律先成草稿」）；命令在本机的系统沙箱里跑（和命令行同一份 `sandbox.js`），
     挡的是**真的**家目录 `run.home` —— 宿主进程自己的 HOME 是外壳给的空目录，照 `os.homedir()` 算的话挡错地方（工具链读不到、工作区就是家目录时 `~/.ssh` 漏出去）。
   - 联网照用户 11-10 定的默认开（`run.sandboxNetwork`，外壳可设 off / local）。没有沙箱不给 shell（Mac 上都有）。
   - 外壳可以叫停：stdin 一行 `{"type":"stop"}`（或 SIGTERM）→ 中断、收掉后台命令、照实交 result。
   - 发给外壳的每一行都不带令牌（多一道：出现就换成 `zqp_…`）。
3. **外壳：`LocalAgent.swift` + `zqLocal` 桥**
   - `LocalAgent`：按需起包里的 node 跑 `Resources/zhiqu-cli/src/host/code-host.js`；不继承环境变量（HOME、TMPDIR 是自己的空目录，PATH 是常见的工具目录 + 包里 node 那个目录）；
     一行一个 JSON 读回来转给页面；一次一轮；叫停时先说 stop、等一会儿 SIGTERM、再 SIGKILL；没交 result 就退出的照实说。
   - run 里要紧的字段外壳自己定，不听页面的：**根目录只认用户在系统选框里选过的文件夹**（`LocalFolders`，存在偏好设置里；不收 `/`、家目录本身）、
     服务器地址是外壳自己的 `Server.url`（令牌只发给自己的网站）、家目录、联网档。页面给的是：选的是哪个文件夹、这句话、前面的对话、模型、思考档位、档位（READ / WRITE / EXEC）、`/init` `/review`、令牌。
   - `zqLocal` 桥（带回复）：`status` / `pick`（系统选文件夹的框）/ `run` / `stop`；事件用 `window.dispatchEvent(new CustomEvent('zq-local', …))` 交给页面。
     和别的桥一样只认自己网站的主框架；只有主窗口接（迷你窗不接）。
4. **打包**：命令行源码（`zhiqu-cli/package.json` + `src/`）拷进 `Resources/zhiqu-cli/`，`LocalAgent.swift` 编进外壳。

## 不做（第 3 步）
页面那一侧：输入框上方的选文件夹、档位在桌面里走桥、代码模式的一轮在桌面里交给外壳、草稿确认后写盘（宿主 / 外壳那边的「写盘」也放第 3 步，和确认按钮一起做）、
回答和步骤存回服务器、`/review` `/init`。这一轮的东西在页面接上之前用户看不到。

## 怎么验
- 命令行判据（`test/desktop-host.test.js`，真沙箱、假网关）：令牌只发给给的服务器、只出现在 Authorization 头里、不出现在发给外壳的任何一行；
  写文件只成草稿、磁盘不变；读不到家目录；家目录按 `run.home` 算（工作区就是家目录时 `.ssh` 照样挡、家目录下的工具链读得到）；联网按档；叫停；后台命令随这一轮收掉。
- 外壳判据（`DesktopLocalAgentTest`，真编译 Swift、真起 node、真沙箱、Java 起的假网关）：桥只认主框架、没选过的文件夹不跑、服务器地址不听页面的、
  一轮从起到 result 的消息都转到页面、叫停后进程和它起的命令都没了、宿主没交 result 就退出照实说。
- 后端判据：令牌的范围（`AccessTokenScopeTest`）、签发和过期（`AccessTokenServiceTest`）、真接口真库（签一张 → 四个接口认、别处不认 → 过期后不认）。
- 打包：真打一次，包里的 node 跑包里的宿主，对假网关走一轮。
- 新判据逐个扰动见红；三组全量。

## 结果
- 外壳、宿主、令牌都已经在工作区里。收口时补了两处 review 查出来的问题：
  - 打包脚本的注释还写着「命令行不随应用打包」，和下面拷 `package.json` + `src/` 对着干。`DesktopLocalAgentTest` 的「外壳接上」之前红在「打包脚本没带上命令行源码」；脚本里的拷贝补上之后这条过了（2/2，含真编译 Swift、真起 node、真沙箱、假网关）。
  - `runHosted` 无条件调 `bridge.onStop`。后端那条路和 `effort.test.js` 的假桥没有这个方法，命令行全量因此红 1 条。改成有这个方法才登记叫停。
- 判据：`DesktopLocalAgentTest` 2/2、`DesktopPageViewTest` 12/12、`AccessTokenScopeTest` 5、`AccessTokenServiceTest` 5、`HarnessUsageIntegrationTest` 3/3（真库：网页登录态签一张 → 模型列表和工具认、用量和 `/me` 不认、令牌换不来令牌 → 过期后不认、列表里不再有）。命令行 `desktop-host.test.js` 含真沙箱（读不到家目录、家目录按 `run.home`、联网三档、叫停收后台命令、真进程三种叫停）。命令行全量 550（531 过、19 跳）。
- 没做的还是第 3 步：页面上的选文件夹、档位、代码模式走桥、确认草稿写盘。这一轮用户在桌面里仍看不到本机代码。安装包没有重打成 dmg（脚本和编译进外壳的源码由上面的判据钉着）。
