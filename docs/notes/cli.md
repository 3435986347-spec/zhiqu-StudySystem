# 命令行 zhiqu 与服务端网关

> 原来是 `CLAUDE.md` 里的「npm 版 zhiqu」「命令行 zhiqu 的 Java 版（2026-10-04 删除）」「命令行 harness 的服务端网关」，第三十八轮（方案第 5 步，`CLAUDE.md` 瘦身）原样挪到这里，一字未改。
> `CLAUDE.md` 现在只留规矩；这里是来龙去脉和细节。文中「上面」「下面」指的是原来 `CLAUDE.md` 里的位置。

### npm 版 `zhiqu`（`zhiqu-cli/`，harness：循环与工具在用户电脑上）

零依赖的 ESM 包，`cd zhiqu-cli && npm link` 装到本机（发布到 npm 之前单独问用户；`package.json` 留着
`"private": true` 挡误发）。服务器那一侧见上面「命令行 harness 的服务端网关」。它接替了 Java 版的
`zhiqu` 命令（Java 版 2026-10-04 删除，桌面包也不再带它；见下面那一小节留下的教训）。不看代码想不到的几件事：

- **三档权限 plan / ask / auto**（用户定的）：plan 只下发读工具 + `exit_plan_mode`，批准计划才切档；
  ask 写 / 跑前给 diff、问 y/n；auto 不问、做完再汇报。**「下发了什么」和「能执行什么」是同一份清单**，每轮重算。
  MCP 工具第一次用三档都问（第三方写的）。
- **本地安全规则与服务器端是同一套**，共用 `conformance/workspace-rules.json`：Java 的
  `WorkspaceRulesConformanceTest` 与 JS 的 `zhiqu-cli/test/conformance.test.js` 跑同一份，
  `HarnessCliNodeSuiteTest` 把 JS 那一侧接进 Maven 全量 —— 两边各自绿不算数，结论一致才算。
  写这份用例时查出「禁行内代码」只做精确匹配：`--eval=…`、`node -pe`、`python3 -Bc` 都能绕过，`npm exec` 会跑没看过的包；
  两边一起收紧。
- **没读过不许改、只读一部分不许整份重写、确认期间被改过不写**（`local.js` 的 prepare / commit 两步）。
  `write_file` 一个工具三种用法（整份 / append / old_string 替换）—— 长文件分几次写，就是为了不撞单次输出上限。
- **截断不是说完了**：`finish_reason=length` 时截断的调用不执行，历史里的参数换成小而合法的 JSON（带 path），
  回模型「分几次写」。单条工具输出按模型窗口截断（窗口 × 0.35 字）—— 否则小窗口模型一轮就超，两边的压缩都救不了。
- **子进程与 MCP 服务器都不继承命令行的环境**（那里有 `ZHIQU_TOKEN`）。超时杀整个进程组（`detached` + `kill(-pid)`）：
  只杀父进程的话孙子进程攥着管道，close 永远等不到 —— 这条判据因此自带 15 秒时限。
- **配置在 `.zhiqu/`**：`~/.zhiqu/config.json`（600）、`system.md`（第一次写一份内置系统提示，没改过的跟着内置更新，
  改过的不动）；项目 `.zhiqu/settings.json` **不收令牌**。项目说明文件是 `ZHIQU.md`（同目录没有才读 `CLAUDE.md`，
  **不读 `AGENTS.md`** —— 用户定的，和 Codex 的重复）。Skills 三层渐进式披露。会话在 `.zhiqu/sessions/*.jsonl`，
  `/resume` 重放，没有结果的工具调用补「被中断」。
- **测试**：`cd zhiqu-cli && npm test`；端到端用 `test/fixtures/mock-model.cjs`（脚本化的 OpenAI 兼容假模型）与
  `mock-mcp.cjs`；`fake-harness.js` 是进程内的假 `/api/harness/**`（延迟与故障可脚本化：闪断、502、卡死、心跳、
  输出一半断开）。`package.json` 是 `"type": "module"`，所以 CommonJS 的夹具必须是 `.cjs`。
- **goal 模式**（`/goal <目标>`、`--goal`，用户要的「圣目标」）：目标置顶进系统提示；模型只有调 `goal_update`
  宣告 achieved（必须附证据）或 blocked（必须写 blocker）才能停，没宣告就收尾会被自动推着接着做；宣告达成后
  **再过一道不带工具的独立核对**（只看目标、证据与真实的工具结果），不过就带着缺口继续；轮数有上限；目标记进会话。
  无人值守（`--goal` 且输入不是终端）的退出码：0 达成 / 2 卡住 / 3 轮数用完。
- **速度：不要用全局 `fetch`，也不要 ESM `import 'node:http'`**（2026-09-24 实测）。调用过一次 fetch，进程退出就多等
  约 2.4 秒；根子是 TLS：环境里设了 `NODE_USE_SYSTEM_CA=1` 时加载 TLS 要把钥匙串里的系统证书全读一遍（1.1～1.5 秒），
  而 **ESM 的 `import 'node:http'` 会顺带把 tls 拉进来**（CommonJS 的 require 不会）。`src/http.js` 因此用
  `createRequire` 加载 http、只在 https 服务器时才加载 https。`whoami` 2.6 秒 → 0.2 秒；`reliability.test.js` 第一条
  钉着「加载 zhiqu 的全部模块不许加载 tls」。
- **重试只在安全的时候**：GET 对闪断与 502/503/504/429 重试两次；POST 只在「连接被拒」（肯定没到服务器）时重试 ——
  中途断开的 POST 可能已经建了草稿；模型流式调用只在**还没有任何实质输出**时重试（服务器在 error 事件里带
  `retryable`：429 / 5xx / 连不上才是 true）。流式有 240 秒空闲超时，服务器每 15 秒发一行 SSE 注释当心跳 ——
  推理模型想一两分钟时，代理和空闲计时都不会误判。存档改成后台队列，失败的下一轮补，一轮只一个请求。
  同一工作区两个 zhiqu 同时改 `setup.json` 会互相覆盖 → 用 `wx` 锁文件（10 秒没动的旧锁清掉）。
  Windows 上 `npm.cmd` 改成 node 直接跑 `npm-cli.js`（不经过 shell），其它 `.cmd` 明确拒绝。
- **输入框一直在**（用户要的）：交互终端里一轮开始后，底部固定一块活动区（流式的半行、排队的消息、状态行、readline 的
  输入行）；输出先擦掉活动区、成行的永久打印、再画回来，输入行交给 readline 自己重画（画之前把它的 `prevRows` 归零）。
  干活时按回车 = 排队，这一轮结束后自动发出并留下「› 消息」。**权限确认只认问出来之后新打的那一行**（原来会先从队列里
  拿，一句排着的「再加个功能」会被当成对「写入？」的回答）。判据用 `test/vt.js`（迷你终端模拟器，`\n` 按 ONLCR
  当 `\r\n` —— libuv 的 raw 模式保留了它）逐字节回放输出再看屏幕。
  **答过的确认要留在屏幕上**：第一版答完之后，问题连同回答跟着活动区一起被擦掉 —— 用户翻回去看不到自己批准了
  什么计划、同意写了哪个文件（2026-09-25 用户贴的记录里一个确认都没有）。而且擦除的行数按「› 」算，长问题折行时
  擦少了，停在半行的流式输出会被重打一遍。
- **工具名编错了要说「没有这个名字」，不能说「这一轮没给」**。模型会把别家 agent 的 `replace` / `edit_file` / `bash`
  带过来；原来一律回「这一轮没有给你这个工具」—— 听着像暂时的，模型重试三次、自己编一句「现在可用了」，最后放弃替换、
  整份重写了文件（用户实测）。现在分两种：存在但这一档不给（说档位）/ 根本没有（说不是暂时的、该用哪个、怎么用；
  别家常见名字各有指路）。网页端 code agent 同理（`CodeWorkspaceAgent.refusal`）：原来那句「如实告诉用户你没有这个能力」
  对编出来的名字是错的 —— 写工具明明下发了，模型会去说「我改不了文件」。那边的拒绝要保留「操作被拒绝」前缀，
  执行轨迹靠它显示（第一版漏了，是判据读轨迹时红出来的）。
- **`delete_file`**（用户要的）：规矩照写入 —— 这段会话读过或写过、之后没被改过才能删，确认期间被改过不删；
  不是抹掉而是挪进 `.zhiqu/trash/<时间>/`；ask 档单独一道确认、单独一个「本会话都允许删除」（允许了写不等于允许了删）。
  `run_command` 仍不许 `rm`，拒绝时指到 `delete_file`。
- **模型不许写、不许删 `.zhiqu/` 与 `.git/`**（`LocalTools.protectedDir`）。原来 `.json` / `.md` 在扩展名白名单里，
  模型能改 `.zhiqu/settings.json`（给自己加允许的命令）、`.zhiqu/mcp.json`（下次启动就拉起它写的服务器）、
  `system.md` / skills（改自己的规矩）—— auto 档连问都不问。判定按软链解开后的真实位置、大小写不敏感
  （`.zhiqu` 还不存在时 macOS 上建出来的 `.ZHIQU/mcp.json` 就是它）。放在命令行这一侧，不进与服务器共用的 `WorkspaceGuard`。
  这是写 `delete_file` 的判据时顺带红出来的：「.zhiqu 里的不许删」那条一开始被「没读过不许删」替它挡着，补上「先读过」才看清写也没拦。
- **输入 / 弹出命令菜单**（用户要的）：`src/commands.js` 是命令清单的唯一出处，`/help` 与菜单都从它来。菜单就是输入行上方
  的几行，和活动区同一套擦 / 画（空闲时临时建一块只放菜单的区域）；按键从 `keypress` 事件上截（包一层 readline 自己的
  监听器），菜单没开时 ↑↓ 照样翻历史。只在主提示符上弹 —— 续行（行尾 `\`）那一行是正文。
- **`/resume` 把那段会话的聊天记录原样显示出来**（用户要的）：读 `SessionStore.transcript()`，不是 `load()` ——
  后者是发给模型的那一份，压缩过就只剩摘要。不是用户打的 user 消息（goal 推的每一轮、截断时补的说明）记录时带
  `origin`，回放时不冒充「› …」；旧记录没有标记，靠那几句固定开头认。
- **`zhiqu mcp`**（第二十九轮，`src/mcp-server.js`）：把远程工具里的八个（Wiki 三个、`list_tasks` / `update_task_status`、`create_study_plan`、记忆两个）
  做成 stdio MCP 服务器给 Claude Code / Cursor 用，令牌用 `zhiqu login` 存的。**stdout 只走协议**（写一个字的日志客户端就断开 —— 真起进程的判据钉着）；
  工具出错回 `isError` 而不是协议错误；转哪些工具是 `EXPOSED_TOOLS` 一个一个列的，服务器新加的远程工具不会自动转出去。
  `update_task_status` 是远程工具里唯一直接生效的（`REMOTE_DIRECT_WRITE_TOOLS`）：plan 档不给，ask 档单独问。`list_tasks` 和网页 AI 读任务是同一个开关。
- **默认服务器**来自 `package.json` 的 `zhiqu.defaultServer`：仓库里是本机桌面应用（测试用），发布版要指向用户的服务器
  （`npm run set-server -- https://…`）；`prepublishOnly` 挡住本机地址、非 https、还挂着 `private` 的版本。

### 命令行 `zhiqu` 的 Java 版（2026-10-04 删除）

原来随桌面应用打包的 `com.zhiqu.cli.*` + `deploy/desktop/bin/zhiqu`，只是后端的客户端；npm 版接替之后删掉了。
留下一条它教会的事：**对照组不死的实验不作数。** 验证「`nohup … &` 拉起的后端不会被终端的 Ctrl+C 带走」时，
实验骗了我三次 —— 最后发现是检测方法：`kill(pid, 0)` 对**僵尸进程**也返回「存在」，直接起的那个 JVM 早死了，
只是没被 `wait()` 回收，于是对照组一直「活着」，两种启动方式分不出来。改成看 `ps` 的状态（排除 `Z`）才看清。
历史登录记录里的 `ZhiquCLI/…` UA 前端照旧认成「命令行」（`LoginDeviceLabelTest`）。

### 命令行 harness 的服务端网关（P1，`/api/harness/**`）

npm 版 `zhiqu` 的循环和本地工具跑在用户电脑上；服务器只管登录、模型网关、对话存档、远程工具（计划见
`docs/zhiqu-harness-plan.md`）。不看代码想不到的几件事：

- **个人访问令牌（`zqp_…`）只在 `/api/harness/` 下被认**，判定只在 `HarnessPaths.acceptsAccessToken` 一处。
  管理令牌的接口故意放在 `/api/access-tokens`（只认网页登录态）—— 泄露的令牌不能给自己续命、不能批准别的设备。
  库里只存 SHA-256（令牌有 256 位熵，不需要慢哈希）。`AccessTokenScopeTest` 连「控制器挂在哪个路径」「放行名单里没有
  `/api/harness/**` 通配」都钉着。
- **设备码登录**：命令行拿 deviceCode（库里存哈希），用户在「设置 → 命令行」里输入 8 位码、看过设备名和来源 IP
  之后点允许；命令行轮询换令牌，`WHERE status='APPROVED'` 的条件更新保证并发轮询只签出一张。
- **模型网关**进出都是 OpenAI 格式；Anthropic 的翻译只在 `AnthropicFormat` 一处（服务器端 code agent 的
  `ModelProviderClient.callToolTurn` 也用它 —— 此前 Anthropic 配置被标成支持工具调用，请求却是 OpenAI 格式）。
  流式里工具名一到就发 `tool_call`、参数每长 2KB 发一次 `tool_progress`：模型写大文件时不是一段沉默。
  供应商嫌 `max_tokens` 大（400）就按 8192 → 4096 重试；按模型窗口最后兜底裁剪（按「一轮」丢，工具调用与结果永远成对）；
  SSRF 校验在发请求那一层；用量记进 `harness_usage`，供应商不报就估算并标 `estimated`。
- **远程工具**（Wiki / 计划 / 记忆）写类一律是草稿：计划、记忆挂在这段会话自己的那一轮 `ai_agent_run` 上，
  网页打开这段会话的 Notebook 就能确认。Wiki 的「这一轮读过什么」按「用户 + 会话」存在进程里（服务重启丢失 =
  要求重读，是安全的方向）。
- **一段命令行会话 = 网页里一个 Notebook**，存档只收 user / assistant。完整记录在工作区 `.zhiqu/sessions/`，那是 `/resume` 用的。
- **模型输出被截断（`finish_reason=length`）不是「说完了」**：原来工具循环把截断的回复当成正常结束，静默收尾 ——
  用户看到的是「一直卡在同一步」。现在抛 `ToolTurnTruncatedException`，code agent 叙述出来并让模型拆小文件重写。
- **工作区可以新建上级目录了，但不静默**：`newDirectoriesFor` 先报出要建哪些，草稿带着 `newDirectories`，确认框里写出来。
  原先「不替用户建目录」让「放在 test 文件夹里」这种请求直接写失败。
