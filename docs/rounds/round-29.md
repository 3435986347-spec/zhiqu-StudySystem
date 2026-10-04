# 第二十九轮（2026-10-04）：命令行接上任务，再做成 MCP 服务器

## 由来
用户 2026-10-04：「能不能把命令行 zhiqu 接到知识 Wiki、任务里面，就是做一个类似于 MCP 的东西」。说清现状之后用户定了：
**两个都做**（先给 zhiqu 加任务工具，再把 Wiki + 任务做成真的 MCP 服务器 `zhiqu mcp`，Claude Code / Claude 桌面版 / Cursor 都能接）；
写任务的规矩：**新建走草稿，改状态直接做**（ask 档照样先问）。

现状：zhiqu 已经有 Wiki（查 / 读 / 写草稿）、计划草稿（`create_study_plan`）、长期记忆这几个远程工具，执行在服务器上
（`HarnessRemoteTools`，`GET /api/harness/tools` 列、`POST /api/harness/tools/call` 调）。**任务一个都没有**。另外两处学生口吻漏网：
命令行的内置系统提示还写着「『知趣·象限』学习系统的命令行 coding agent」，计划工具在终端里显示成「生成学习计划草稿」——
第二十六轮的扫描只扫了网页和后端，没扫 `zhiqu-cli`。

## 计划（开工时）

1. **两个远程任务工具**（服务器上，`HarnessRemoteTools`；加在这里，命令行和 MCP 自动都有）：
   - `list_tasks`（读）：没做完的任务，和网页 AI 读到的是同一份拼法（`AssistantTaskContext`），多带一个 `#编号` —— 改状态要用。
     **和网页同一个开关**：个人中心关了「让 AI 读我的任务」，这里也读不到，回一句关着、去哪开。
   - `update_task_status`（写，**直接生效**）：`task_id` + `todo / doing / done`，只能改自己的（走 `StudyTaskService.updateStatus`）。
   - 新建任务照旧走 `create_study_plan`（草稿，网页确认）。
2. **命令行**：`list_tasks` 算读工具（plan 档也给）；`update_task_status` 算写：plan 档不给，ask 档先问（说清楚改哪一条、改成什么），auto 档直接做。
   终端里的说法改成办公口吻（「生成计划草稿」）；内置系统提示换成「AI 办公助手的命令行 agent」，并写明任务这三件事怎么用。
3. **`zhiqu mcp`**：零依赖的 MCP 服务器（stdio，按行收发 JSON-RPC，协议 `2025-06-18`），把 Wiki / 任务 / 计划草稿 / 长期记忆这几个远程工具
   原样转出去（用命令行登录时存的令牌），带上 `readOnlyHint`（读的那几个）好让客户端分得清。一个 MCP 进程 = 一段会话
   （草稿挂在网页里一个「MCP · 客户端名」的 Notebook 上）。stdout 只走协议，日志写 stderr。没登录时说「先在终端运行 zhiqu login」。
   README 写上 Claude Code / Claude 桌面版 / Cursor 怎么接。
4. **判据**：服务器（读任务带编号、开关关着读不到、改状态只能改自己的、编号 / 状态不对说清楚）；命令行（档位：plan 不给写、ask 问、auto 不问；
   说法）；MCP（握手、列工具、调用转发会话 id 和参数、出错是 `isError` 而不是协议错误、stdout 里只有协议消息、没登录）；
   把 `zhiqu-cli/src` 加进 `PositioningCopyTest` 的扫描。

### 怎么验
命令行对着本机的验证服务器真跑一遍（读任务 → 标完成 → 网页里看到状态变了）；用一个真的 MCP 客户端（命令行自己的 MCP 客户端）连 `zhiqu mcp`
列工具、调 `list_tasks`。扰动见红；`npm test`、全量通过。

## 结果（2026-10-04）

照计划做完。
- **服务器**：`HarnessRemoteTools` 加 `list_tasks`（`AssistantTaskReader.read(userId, true)`，同一份拼法带 `#编号`；开关关着回 `AssistantTaskContext.DECLINED`）
  和 `update_task_status`（`#12` 和 `12` 都认；状态只认 todo / doing / done；不是自己的任务、编号不对都回一句话，不抛到协议层）。
- **命令行**：`list_tasks` 进了只读工具（plan 档也有）；`update_task_status` 是新的一类「远程、直接生效」—— plan 档不给，ask 档问
  「把任务 #12 标成已完成？」、单独一个「本会话都允许改任务状态」（允许了写文件不等于允许了改任务），auto 档不问。终端里「生成学习计划草稿」→「生成计划草稿」；
  内置系统提示从「『知趣·象限』学习系统的命令行 coding agent」改成「AI 办公助手的命令行 agent」，并写明 Wiki / 任务 / 记忆哪些是草稿、哪些直接生效。
  没改过 `~/.zhiqu/system.md` 的人跟着内置的更新。
- **`zhiqu mcp`**（`src/mcp-server.js`，按需加载）：握手协商版本（认得的照回）、`tools/list` 只转八个工具并标 `readOnlyHint`、`tools/call` 带同一个会话 id
  转给服务器（第一次调用时以「MCP · 客户端名」开会话）、草稿在结果里说明要到网页确认、出错回 `isError`（工具结果，不是协议错误）、没登录说「先 zhiqu login」。
  README 写了 Claude Code / Claude 桌面版 / Cursor 的接法。
- `PositioningCopyTest` 加扫 `zhiqu-cli/src`（第二十六轮漏掉的就是这里）；README 里「学习数据」「排学习计划」两处一起改了。

**判据**：`HarnessRemoteToolsTest`（新 3 条：声明、读任务跟着开关、改任务状态）、`AssistantTaskContextTest`（编号）、`PositioningCopyTest`（命令行）、
`zhiqu-cli/test/agent.test.js`（plan 档的工具清单加上 `list_tasks`、不含 `update_task_status`；改状态 ask 问 / n 不调 / y 调 / auto 不问）、
`zhiqu-cli/test/mcp-server.test.js`（6 条，最后一条真的起 `zhiqu mcp` 进程：stdout 每一行都是协议消息、用令牌调到服务器、stdin 关了就退出）。
扰动 16 个全红（其中「stdout 里打了一行日志」就是真起进程那条照出来的）。

**真机**：命令行自己的 MCP 客户端（`McpManager`）起 `zhiqu mcp`，后面是真的后端（`zhiqu_verify`）：握手 ready、列出 8 个工具；`list_tasks` 先回
「用户关掉了让 AI 读我的任务」（这个测试账号第二十七轮验证时关的 —— 开关在 MCP 上也算数），打开之后回两条带编号的任务；`update_task_status #3077 done` →
「已把 #3077「整理周会纪要」标成已完成」，库里 status = 2、`completed_at` 有值，再列只剩一条（计划里写的是「网页里看到状态变了」，实际看的是库和再列一次 —— 网页读的是同一张表）；拿别人的任务编号 #1 → 「没有改成：任务不存在或无权访问」，库里没变。
验证用的个人访问令牌用完撤销了。

**验**：全量 945 / 0 / 0 / 0（开着 Docker）；npm 版 244 / 244；桌面应用重新打包（命令行默认连的就是本机桌面应用 —— 新的远程工具要在包里的后端上才有）。
