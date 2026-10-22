# 代码工作区（coding agent 的磁盘面）与限额边界

> 原来是 `CLAUDE.md` 里的「代码工作区（coding agent 的磁盘面，默认关闭）」「限额边界」，第三十八轮（方案第 5 步，`CLAUDE.md` 瘦身）原样挪到这里，一字未改。
> `CLAUDE.md` 现在只留规矩；这里是来龙去脉和细节。文中「上面」「下面」指的是原来 `CLAUDE.md` 里的位置。

### 代码工作区（coding agent 的磁盘面，默认关闭）

AI 助手原本只是个「work agent」（排计划、写 Wiki、做检索）。工作区是给它加的读代码能力
——「工程即文件夹」：**不建 `code_project` 表**，没有归属检查、没有乐观锁、没有迁移，
版本由用户自己的 git 管。

**默认是关闭的，而这个默认值本身就是安全边界**（`WorkspaceModeTest.默认必须是关闭的` 钉着它）。
四个档位 `OFF / READ / WRITE / EXEC`（`WorkspaceMode`），`parse()` 对任何认不出来的配置值
**回落到 OFF 而不是就近取一档** —— 把 `mode: ON` 写错成一个不存在的值时，该得到「没开」，
不是「开了个小的」。三档都已实现：READ 读、WRITE 写草稿（确认后落盘）、EXEC 再加执行沙箱。

**档位与根目录现在能从界面切换**（AI 助手页工作区面板的 ⚙，`PUT /api/workspace/settings`），
不必再改 `application.yml`；用户的选择持久化在 `~/.zhiqu/workspace-state.json`
（桌面每次重启新 JVM，不持久化就每次回到 OFF）。文件夹选择器走 `GET /api/workspace/browse`
（只列目录、管理员 + 回环）。**切换绕不过下面三条前提** —— `WorkspaceService.applySettings`
只改「想要什么」，`rebuild` 每次重跑那三条裁决「实际允许什么」，所以公网（非回环）上无论
点到哪、持久化里存的是什么，`effectiveMode` 都还是 OFF。持久化存的是<b>用户选的档位</b>
而非降级结果 —— 把同一份 state 拿到回环机器上，原本想要的档位自动恢复。
`WorkspaceRuntimeToggleTest` 钉住这整条不变量（尤其「非回环上切 EXEC 仍是 OFF」）。

生效还要三个前提**同时**成立，缺一就整体降级到 OFF（`WorkspaceAccess`）：

1. `app.workspace.mode` 不是 OFF
2. `app.workspace.root` 指向一个存在的目录
3. `server.address` 是回环地址

第三条是硬前置：`application.yml` 里只有 `server.port`，服务默认监听所有网卡
（实测 `TCP *:18080 (LISTEN)`）。一个能读你硬盘的服务不能是这个状态。注意
`isLoopback(null)` 与 `isLoopback("")` 都返回 **false** —— 「没配」是最常见的配置，
它必须落在拒绝的一侧，否则默认部署就是敞开的。`configuredMode()` 与 `effectiveMode()`
分开报告，前端才能说清「你配了 EXEC，但因为没绑回环所以实际是 OFF」。

`WorkspaceGuard` 在路径上有六道判定，每道都有各自不同的拒绝理由（`Reason`）：
normalize + `startsWith(root)` 防 `../`、拒绝符号链接、只许普通文件、扩展名白名单、
单文件大小上限、目录条目数上限。**扩展名白名单不是为了安全**（`startsWith` 才是），
是为了别把 `.env` / `.pem` / `id_rsa` 喂进模型上下文；所以列目录时就把不可读的文件
标成不可读，而不是等用户点开才拒绝。

四个 HTTP 端点 `/api/workspace/{status,files,file,search}` **全部要管理员**（`WorkspaceControllerGuardTest` 扫的是「每个 `@*Mapping` 都要调 `requireAdmin()`」，所以新加端点会被自动纳入，不用改判据）。理由不是权限模型，
是这个功能读的是**服务器**的磁盘 —— 多用户部署里，普通用户能读的应该是他自己的东西，
而工作区里没有一个字节属于他。

搜索是**字面量匹配、不接受正则**：这个入口的调用方是模型，而 `(a+)+b` 这类正则在不匹配时
会灾难性回溯，把我们自己的 JVM 跑满几分钟 —— 模型没有恶意也会写出来。三道上限各挡一件事：
`maxSearchFiles` 挡「根目录指错了」、`maxSearchHits` 挡搜 `the` 把模型上下文塞满、
`maxSearchLineChars` 挡压缩过的 .js 单行几十万字符。命中截断时**必须说出来**——
模型把「80 条」当成「一共 80 条」就会给出错误结论。

`CODE_AGENT` 节点的门收在 `AgentPlanDecision.codeIntent(message)`，与既有的
`wikiToolIntent` 并列 —— 不要在实现里另起一个判定，那正是 `RETIRED_DECIDERS` 在防的事。
这个门**会过触发**（「今天写了三小时代码，有点累」同时命中「写」和「代码」），这是
故意的：过触发的代价是白读几个文件，漏触发的代价是用户问代码问题却得到一个没看过代码的
回答。`CodeAgentGateTest.已知会过触发的那一类` 把它钉成了明示的取舍，不是待修的 bug。

**工作区写入（阶段 2）走的是 Wiki 那条已经验证过的路：草稿 → 用户确认 → 落盘。**
模型调 `write_workspace_file` 只产出 `CODE_DRAFT` 工件，磁盘一个字节都不动；
只有 `POST /api/ai/artifacts/{id}/confirm` 才会写。四条纪律各挡一件事：

- **最小权限** —— 写工具只在 `canWrite`（工作区档位允许写 **且** `codeWriteIntent` 成立）
  时才下发。不下发，模型就不会尝试，也不会承诺自己改了文件。写这道门比读那道窄得多
  是刻意的：读过触发只是白读几个文件，写过触发会弹出一个用户没要的确认框，而确认框本身
  就诱导人去点。
- **基线** —— 草稿记下 agent 读到该文件那一刻的内容指纹（SHA-256；`String.hashCode()`
  是 32 位、可构造碰撞，不够）。确认时比对磁盘现状，不符就拒。文件当时不存在则基线是
  `WorkspaceService.ABSENT`，确认时它已存在同样要拒 ——「新建」和「覆盖」是两件事。
- **没读过不许改** —— 对已存在的文件，模型必须先 `read_workspace_file`。没读过就改是
  拿想象中的内容覆盖真实内容。
- **成批要么全写要么全不写** —— `writeAll` 先把每个文件都校验一遍再动手。边校验边写的话，
  第三个文件基线不符时前两个已经落盘，用户看到一条报错却不知道工作目录被改了一半，
  而那一半属于一个他没有完整确认的方案。这**不是事务**（写到一半磁盘满仍会留半批），
  它消掉的是唯一一种可预见的半批。

写盘用「临时文件 + 原子改名」：直接就地写，中途失败会留下一个被截断的源码文件。

**读工作区也要管理员。** `/api/workspace/**` 限了管理员，而 code agent 一度只检查档位 ——
那样普通用户对助手说一句「看看 xxx.java」就绕过了那道门，HTTP 那一侧的限制等于装饰。
判定收在 `AiServiceImpl.workspaceReadableBy(userId)` 一处，`CodeAgentGateTest` 断言
`effectiveMode().allowsRead()` 在全文件只出现一次。

**目录软链曾经能把工作区漏出去。** `normalize()` 是纯字符串运算，不解析软链；而守卫只检查
路径最后一段是不是软链。于是 `root/docs -> /别处` 存在时，`docs/secret.md` 两道检查都通过。
`node_modules/.bin`、`docs -> ../shared` 这类软链在真实项目里很常见。现在
`WorkspaceGuard.containedAfterSymlinks` 用 `toRealPath()` 解开每一段再比，**root 自己也要
realpath** —— 否则 macOS 上 `/tmp` 实际是 `/private/tmp`，正常读取会全部失效。

**执行沙箱（阶段 3）默认关闭，而且它不是你以为的那种沙箱。**
白名单里有 `python3` / `node` / `java`，**允许它们就等于允许任意代码** —— 一段 Python 能删掉
用户的家目录，`WorkspaceExecutor` 拦不住，进程级隔离（容器 / seccomp）不在这一层。
把它叫「沙箱」而不说这一点，会让人以为代码被关住了。

真正的边界是**只能跑用户已经看过的代码**：

- **禁行内代码开关**（`-c` / `-e` / `--eval` / `-i` …）。有了它们，模型可以把任意程序当成
  一个参数传进来，那段代码没有经过任何人的眼睛。禁掉之后执行对象只能是工作区里**已经存在
  的文件** —— 要么用户自己写的，要么走过 `CODE_DRAFT` 的 diff 确认。**这是这一层唯一
  真正意义上的安全判定**，其余几条都只是「炸了也炸不大」。
- 参数不接受绝对路径与 `..`；命令只接受命令名 + 参数数组，不接受任意 shell 字符串。

开启前提在档位之上又加了一条：**生产 profile 一律拒绝**（`spring.profiles.active` 含
`prod`/`production`），与档位一起收在 `WorkspaceExecutor.enabled()` 里 —— 调用方不许复述
那两个条件，`CodeAgentGateTest.不允许执行时不得下发执行工具` 钉着这一点。

四条资源约束，每条都有行为判据（用真进程跑，不 mock）：

- **超时** → `destroyForcibly`。第一版这里是错的：输出是**同步**读的，而 `read()` 要等进程
  退出才返回 `-1`，于是 `sleep 30` 把读循环阻塞 30 秒，`waitFor` 的超时根本轮不到执行。
  源码扫描和 mock 都发现不了，只有真跑一个死循环才会发现。现在读在独立线程上。
- **输出上限** → 截断并**明确标注**。到上限之后要**继续排空并丢弃**，不能 `break`：
  停止读取会让管道写满、子进程卡在 write 上再也退不出去，一个「日志很多但确实成功了」的
  构建会被报成超时。
- **工作目录**在工作区内。
- **不继承父进程环境变量** —— 最容易漏的一条。主进程里有 `ZHIQU_SYSTEM_AI_API_KEY`、
  数据库密码；继承的话用户让 AI「跑一下这个脚本」，一句 `os.environ` 就全拿走，而输出会
  原样回到模型上下文里。`environment().clear()` 之后子进程没有 `PATH`，所以命令名在**父进程**
  那一侧解析成绝对路径再交下去（用父进程的 PATH 去*找*，不等于把它*传下去*）。
  这条判据不维护「良性变量名单」：macOS 的 python3 shim 在 `env -i` 下也会注入
  `CPATH/LIBRARY_PATH/MANPATH/SDKROOT/__CF_USER_TEXT_ENCODING`，手写名单要么把它们当泄漏
  （假红），要么放行它们（换平台就漏掉真泄漏）。判据改成**现场量一次解释器自己的地板**
  再相减，并单独断言子进程的 `PATH` 是我们给的固定值。

执行结果不落库（不建 `code_run` 表）：那是临时诊断信息，不是需要长期保存的资产。

**刷题与判题（阶段 4）没有新实体 —— 它是已有零件的一条环路。**
出题 = `write_workspace_file`（草稿 → 确认落盘）；判题 = `run_workspace_command`；
错题归档 = `create_wiki_patch` 写 `pageType=WEAKNESS`。四步全部复用已验证过的路径，
**不建「错题本」表**。

为此 code agent 拿到了 Wiki 的三个工具，但分两档：

- **读工具（`search_wiki` / `read_wiki_page`）一直给** —— 出题之前先看这个人以前错在哪，
  题才出得准。
- **写工具（`create_wiki_patch`）只在本轮真的跑过一次判题之后才给**（`CodeLoopState.ranCommand`）。
  门开在「跑过没跑过」这个**事实**上，而不是关键词上：关键词会过触发也会漏触发，
  而「这一轮有没有执行过命令」是确定的。为此工具表**每轮重建** —— 一次性算好的话，
  这个条件只能用「用户说了什么」来近似。

Wiki 调用原样交给 `executeWikiTool`，**不在 code 循环里另拼一份**。那条路上有一整套防护，
其中「**未完整读取不许整页覆盖**」对错题归档尤其要紧：薄弱点页是累积的，一次整页覆盖
就把用户以前记的全冲掉了。提示词因此要求先 `read_wiki_page` 读全，再把新的一条追加上去。

**这一阶段最重要的发现是靠实测拿到的，不是靠读代码。** 沙箱、判题、归档全建好之后，
拿十一种真实说法探了一遍 `codeIntent` / `codeWriteIntent` —— **一条都不命中**。
也就是说整条环路建好了而用户永远走不到。于是有了第三道门 `practiceIntent`，两档：
「我的解法」「练习题」「刷题」这类足够具体的词单独成立；「考考我」「出一道」这类通用词
要配一个学科词（算法/递归/二叉树…）或代码名词，否则背单词也会把 code agent 拉起来。

`practiceIntent` 与 `codeIntent` 的 OR 收在 **`codeAgentIntent` 一处**，建图与执行共用。
第一版只改了建图侧，执行侧 `runCodeWorkspaceAgent` 判的还是 `codeIntent` —— 刷题那一轮
图里造出 CODE_AGENT 节点、runner 直接返回空，用户在执行轨迹里看到一个什么也没做的方块。
`CodeAgentGateTest.实现侧只能调用这道门不能另起一套` 现在盯着这一点。

**已知接不住的那一类（明示的取舍）**：「给我出一道题」「跑一下测试看我写对没有」
「复盘一下刚才那道题」。它们缺的不是词而是**上下文** —— 只有在「刚才出过一道题」之后
才说得通，而本仓库所有的门都只看当前这一条消息。`CodeAgentGateTest.已知接不住的那一类`
把它钉住了，免得下一个人当成漏洞往词表里随手塞词。

**项目式引导（阶段 5）同样没有新实体。** 里程碑走的是 PLANNER 那条已有的路：
code agent 在项目语境下拿到 `create_study_plan`（**同一个 schema，不另写**），
产出的 `{tasks, routines}` 放进 `suggestedPlan`，由既有的 `TaskDrafterRunner` 变成
`TASK_DRAFT` / `ROUTINE_DRAFT` 工件，再走既有的确认分支进日历。自己另猜一套字段名的话，
确认落库时会静默丢掉象限、时长、截止日期，而任务照样建出来 —— 没人会发现。

**这条链路原本有两处断点，都不报错：**

1. `needsTaskDraft` 只看 `TASK_DRAFT_WORDS`，项目语境下为假 → 图里没有 TASK_DRAFTER 节点
   → `inGraph` 为假 → runner 不跑。里程碑放进了 `suggestedPlan`，却没人把它变成工件。
2. `PlanExtractorRunner` 在 POST_STREAM **无条件**赋值 `suggestedPlan`，而
   `suggestPlanFromChatIfNeeded` 在非 `taskCreationIntent` 时**必然**返回空计划 ——
   PRE_STREAM 放进去的里程碑在这里被悄悄抹掉。现在的规则是：**空的不许盖掉非空的**。

两处都是「看起来接通、实际永远产不出东西」。

**四道意图门的关系**：`codeIntent`（读/审阅）、`practiceIntent`（刷题）、`projectIntent`
（项目式引导）三者 OR 成 **`codeAgentIntent`**，建图与执行共用这一个表达式。
后两道各自分两档：足够具体的词单独成立，通用词要配一个代码名词或学科词 ——
`带我做` / `分几步` 第一版放在单独成立那档，实测把「带我做一道红烧肉」「分几步走完这个学期」
也拉了进来。**每加一道门都要拿十来条真实说法探一遍**，正例反例一起探。

**第五道门 `buildIntent` 与「代码」开关（2026-09-23）。** 工作区已经在界面切到「读+写+运行」，
用户说「帮我做一个小游戏，放在test文件夹里」，得到「我无法直接操作你的电脑」—— 图里根本没有
CODE_AGENT：读门动作词没有「做」，写门没有「放在」。两层都漏了。修法两半：

- 输入框旁的**「代码」按钮**（`contextOptions.codeMode`，只认字面 `true`，只在工作区生效时出现）。
  按下就不再猜意图、并给写工具；但**绕不过**工作区的回环 / 管理员 / 可读前提。
  `AgentPlanDecision.codeAgentIntent(message, options)` / `codeWriteIntent(message, options)`
  是这个 OR 的唯一出处，建图与执行共用。
- `buildIntent`：造（做一个/写个/生成一个…）+ 成品名词 / 语言名 / 算法词，或造 + 放进文件夹。
  四批四十余条实测说法定的词表，其中三处是**放宽之后实测出来的误伤**再收窄的：裸「目录」
  （「写到复习目录里」）、「存在」（「目录里存在的问题」）、「python 学习计划」一类
  （学习产物词出现时，语言名是学习对象而不是工具）。「那你直接写进去吧」这类追问接不住，
  由按钮兜底 —— 别往词表里塞「写进去」。

同一次还修了三件「看起来接通、实际没用」的事：最终回答原来**无条件**被告知「你这一轮没有写文件的能力」
（草稿弹出来了，回答却说改不了 —— 现在由 `CodeContextPrompt` 按本轮是否有草稿分支）；
显式请求沿用关键词的 4 轮 30 秒预算（写一个完整小游戏做不完 —— `CodeLoopBudget` 分两档，
显式 10 轮 180 秒，且要给最终回答留出一分钟）；工具循环对外只有开头结尾两条事件
（现在每次调用前后各发一条 `agent.step.note`，`CodeToolNarration` 负责说成人话，
网页轨迹与 CLI 读同一份；命令输出进 innerHTML 前必须转义，`step-note-check.js` 用对抗性输出判）。

### 限额边界

`WorkspaceBoundaryTest` 专门钉各处上限的「正好 / 差一 / 多一」。限额处的 off-by-one
是最容易静默出错的一类：功能照常工作，只在某个刚好的尺寸上多拒一个、少拒一个。
写这一批时抓到两个真的：

- **执行输出正好等于上限时被标成「已截断」**（`read >= room` 应为 `>`）。后果不是崩，
  是模型对用户说「还有更多」，然后建议他换个更窄的命令白跑一次。
- **列目录到 `maxEntries` 静默截断**，一个字都不说。600 个文件的目录返回 500 条，
  模型据此说「这个目录有 500 个文件」或者下「这里没有 X」的结论。搜索那边早就报截断了，
  列目录这边漏了 —— 同一条纪律只落实了一半。现在 `listing()` 返回 `{entries, truncated}`，
  控制器、工具层、前端三处都要把它说出来（做出信号却不用，等于没做）。

另外钉住：**上限算的是字节不是字符**。中文一个字三字节，按字符算的话 256KB 的上限
实际变成 768KB，防 OOM 的意义打三折。

**「最小权限」的那几道门原来只管声明、不管执行。** `canWrite` / `canExec` / `ranCommand`
决定把哪些工具<b>声明</b>给模型，而执行侧是<b>按名字分派</b>的 —— 模型（或者一个被注入了
指令的工具返回值）报一个没下发过的名字，照样会被执行。门是建议性的，不是强制的。

这一点单元判据看不到：它们验的是「该不该下发」，而不是「没下发的能不能调到」。
是端到端扰动撞出来的 —— 把写工具改成永不下发，`CODE_DRAFT` 草稿照样产了出来。
现在每一轮先 `offeredToolNames(tools)` 收一份清单，分派前比对，不在清单里就拒绝并
告诉模型「这一轮没有给你这个工具」。**「下发了什么」和「能执行什么」必须是同一份清单。**

`CodeAgentLoopIntegrationTest` 用脚本化的假模型把整条刷题环路真跑一遍
（读文件 → 跑判题 → 记薄弱点 → 生成改动草稿）。其中一条断言是间接的，而这正是它最硬的
地方：「薄弱点草稿存在」<b>证明了命令确实跑过</b> —— `create_wiki_patch` 只在 `ranCommand`
置位之后才下发，拿不到工具就调不出来。
