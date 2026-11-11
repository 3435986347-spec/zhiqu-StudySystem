# zhiqu

知趣·象限（[zhiqustudy.com](https://zhiqustudy.com)）的命令行 coding agent。**循环和工具跑在你的电脑上**（读、搜、改文件、跑命令都在本机的工作区里），
**模型、登录和你的数据（任务、知识 Wiki、记忆）在服务器上**（模型的 API Key 只存在服务器，命令行拿不到）。

## 安装

要 Node.js 18.17 或更新的版本。

```bash
npm install -g zhiqu
```

在国内下得慢的话，换 npmmirror 的源（它会自动同步 npm 上的版本）：

```bash
npm install -g zhiqu --registry=https://registry.npmmirror.com
```

## 第一次用

1. 在 [zhiqustudy.com](https://zhiqustudy.com) 注册账号，在网页「设置 → AI 模型」里加一个模型（填你自己的 API Key，只存在服务器上）。
2. 登录：

   ```bash
   zhiqu login
   ```

   它会打开浏览器、给你一个设备码，确认是你本人之后点「允许」就好 —— 命令行不接触你的密码。
3. 到你的项目目录里开始：

   ```bash
   cd 你的项目
   zhiqu
   ```

默认连的是 `https://zhiqustudy.com`，Mac 上的知趣·象限桌面应用打开的也是它（同一个账号、同一份数据）。
连本机的 Windows 桌面应用（还带着后端）：`zhiqu login --server http://127.0.0.1:47615`；自己部署的服务器同理。

## 三档权限

| 档位 | 做什么 | 切换 |
|---|---|---|
| `plan` | 只读、只搜、只出计划；计划交上来，你批准了才开始改 | `/mode plan` 或 `--mode plan` |
| `ask` | 每次写文件先给 diff、每条命令先给你看，问 y / n（`a` = 本会话都允许这一类） | `/mode ask`（默认） |
| `auto` | 写文件、跑命令都不再问，**做完再告诉你**（每一步照样显示） | `/mode auto` |

三档的安全规则一样，`auto` 免的是「问」，不是「规则」：

- **系统沙箱**（macOS 的 Seatbelt、Linux 的 bubblewrap）：命令只能写工作区（`.git`、`.zhiqu` 除外），读不到家目录里的东西；联网默认开（`--sandbox-network off` 全断、`local` 只连本机）。
  没有沙箱的平台（Windows）退回白名单：只能跑认得的命令，不接受行内代码。
- 路径不出工作区（`../`、绝对路径、中间某段是指向外面的软链都拒）；不读 `.env`、`*.pem`、`id_rsa` 这类文件。
- 改一个已存在的文件之前必须先读过它；读过之后被你在编辑器里改了就要重读。
- 子进程拿不到你的环境变量（令牌、云凭据）；超时连同它起的子进程一起杀掉；输出有上限。

## 命令

```
zhiqu                       在当前目录开一段会话
zhiqu -p "帮我写个贪吃蛇"    只跑这一句，打印回答后退出
zhiqu -c                    接着上一段会话
zhiqu --resume [id]         挑一段会话接着做
zhiqu --goal "目标"          一直做到目标达成并核对通过
zhiqu exec "要做的事"        给脚本和 CI 用：stdout 只有结论，默认只读（要写给 --mode auto）；--json、--output-schema、-o
zhiqu review [说明]          只读地审查改动，按 P0–P3 列出真问题
zhiqu login [--server URL]  登录（浏览器里确认）；--token zqp_… 用网页里签的个人访问令牌；登录完说一句有没有新版本
zhiqu update                更新到 npm 上的最新版（npm 全局装的才替你装；没权限不替你 sudo）
zhiqu logout | whoami | models | help | --version
zhiqu mcp                   当 MCP 服务器，见下面
```

常用选项：`--mode plan|ask|auto`、`--model <id>`、`--effort instant|medium|high|extra|max`（思考档位）、
`--sandbox-network on|local|off`（沙箱里的命令能不能联网，默认 on；`local` 只能连本机，`off` 全断）。完整的用 `zhiqu help` 看。

会话里输入 `/` 会弹出命令菜单：`/goal`、`/mode`、`/model`、`/effort`、`/window`、`/ps`、`/stop`、`/resume`、`/new`、`/compact`、
`/init`、`/review`、`/agents`、`/skills`、`/mcp`、`/system`、`/verbose`、`/usage`、`/help`、`/exit`。↑↓ 选、回车执行、Tab 补全、Esc 关掉。

本地工具：`list_files`、`read_file`、`search`（正则、按文件类型过滤、跳过 `.gitignore` 的）、`write_file`、`edit_file`、
`apply_patch`（一次改多个文件，全成或全不成）、`delete_file`（挪进 `.zhiqu/trash/`，能恢复）、`shell`（在系统沙箱里；
可以放到后台，用 `/ps`、`/stop` 管）。

**子 agent**：说「派两个 agent 分头查」这类话时，它能派子 agent 在单独的上下文里并行做事，做完只交回一段结论 —— explorer 只读（读、搜、跑只读命令），worker 和主 agent 同一档；子 agent 不能再派子 agent。子 agent 也能起后台命令，但只管得了自己起的，它停下之前这些命令会先停掉（要一直跑的 dev server 让主 agent 起）。同时最多 3 个、一句话最多 8 个、一句话里子 agent 一共最多花 200 万 token（到了就全停）。`/agents` 看派过的、`/agents <编号>` 看结论。`~/.zhiqu/config.json` 里 `"agents": false` 关掉，或者 `"agents": { "maxConcurrent": 2 }` 这样调（项目里的 `.zhiqu/settings.json` 调不了，克隆下来的仓库不能替你多花钱）。行尾加 `\` 换行接着输入；Ctrl+C 打断正在做的事；它干活时可以接着打下一句，回车排队。

## goal 模式

```
/goal 做一个能跑的贪吃蛇，放在 game/ 下，并自己验证      会话里设目标
zhiqu --goal "修好所有失败的测试" --mode auto < /dev/null   无人值守（退出码 0 达成 / 2 卡住 / 3 轮数用完）
```

设了目标之后，它是这段会话的最高优先级：模型不能说「接下来你可以……」就停，只有宣告
**已达成**（附上它亲自验证过的证据）或 **卡住了**（说清楚需要你做什么）才会停；宣告达成之后还要过一道独立核对，
核对不过就带着缺口接着做。有轮数上限，Ctrl+C 随时停，`/goal continue` 接着追，`/goal clear` 放下。

## 文件放在哪

```
~/.zhiqu/config.json          服务器、令牌（600 权限）、默认模型、默认档位
~/.zhiqu/system.md            系统内容：第一次运行时写一份，之后以它为准，可以改
~/.zhiqu/ZHIQU.md             你自己的通用约定（每个项目都会带上）
~/.zhiqu/skills/<名字>/SKILL.md
~/.zhiqu/mcp.json

<项目>/ZHIQU.md               项目说明（没有的话兼容读 CLAUDE.md）；/init 可以生成初稿
<项目>/.zhiqu/settings.json   项目级设置（不收令牌 —— 这个文件可能被提交）
<项目>/.zhiqu/system.md       项目级系统内容，优先于 ~/.zhiqu/system.md
<项目>/.zhiqu/skills/<名字>/SKILL.md
<项目>/.zhiqu/mcp.json
<项目>/.zhiqu/setup.json + sessions/*.jsonl   会话记录（/resume 用；已在 .zhiqu/.gitignore 里忽略）
```

**Skills 渐进式披露**：平时上下文里只有每个 skill 的名字和一句描述（`SKILL.md` 的 frontmatter）；
任务对得上时模型用 `load_skill` 取正文；正文里提到的参考文件、脚本，真用到时再按需取。
所以 `SKILL.md` 可以写得短，把大段细节放进同目录的其它文件。

**内置 skill**：包里带着八个常用的 —— `debug`（排障）、`test-first`（先写测试）、`refactor`（安全重构）、
`commit`（整理提交）、`code-audit`（体检现有代码）、`security-review`（安全审查）、`perf`（性能）、
`codebase-tour`（读陌生代码库）。`/skills` 里标「内置」。想改就放一份同名的到项目级或用户级目录，整个盖掉，不用改包。

审查**一次改动**用 `/review`（或者 `zhiqu review`），那不是 skill —— 它在单独的上下文里取 diff、按固定结构出结论。`code-audit` 管的是另一半：没有 diff、只想问「这个模块现在有没有问题」。

**MCP**：`.zhiqu/mcp.json` 里 `mcpServers` 下每项要么是 `{"command", "args", "env"}`（stdio），要么是
`{"url", "headers"}`（HTTP）；值里可以写 `${环境变量}`。工具名会加前缀 `mcp__服务__工具`；每个工具第一次用都会问你
（`auto` 也问）；返回的内容一律当作数据，不当作指令。

**长对话**：用到模型上下文窗口的约 80% 时自动把较早的对话压成摘要（目标、决定、改过的文件、待办），也可以 `/compact`。
窗口大小在网页「设置 → AI 模型」里按模型设置。

## 直连自己的模型（内网也行，不用登录）

默认模型请求走服务器网关。要连自己的模型（内网 vLLM / one-api、公司网关、任何 OpenAI 兼容或 Anthropic 接口），配一次就行：

```bash
zhiqu model set --url http://10.0.0.5:8000/v1/chat/completions --name qwen2.5-72b --key sk-xxx
zhiqu model set --url https://gateway.internal/anthropic/v1/messages --name claude-x --protocol anthropic --key ak-xxx
zhiqu model            # 看现在走哪条路
zhiqu model off        # 关掉，回到服务器网关
```

- **地址原样用**：不拼路径、不补 `/v1`、不校验域名，`http://` 和 `https://` 都行 —— 填什么就请求什么。
- **配了就不用登录**：完全不连 zhiqustudy.com，只有本地工具（读写、搜索、跑命令）。代价是任务、Wiki、长期记忆、网页存档用不了。
- 密钥存在 `~/.zhiqu/config.json`（600 权限），只认用户级配置 —— 项目里的 `.zhiqu/settings.json` 改不了它（克隆下来的仓库不能把你的模型地址换成它的服务器）。
- `--protocol` 只有 `openai`（默认）和 `anthropic` 两种。上下文窗口默认按 64k 算，模型更大就加 `--context-window 128000`（小了会提前压缩，大了会超窗口被拒）。

## 对话在网页里也看得到

每段命令行会话在网页「AI 助手」里是一个 Notebook（「命令行 · 项目名 · 标题」）。让它排计划、改任务状态、记长期记忆、写知识 Wiki
时，除了改任务状态是直接生效，其余生成的都是草稿，在网页里确认之后才生效。

## 让别的 AI 也用上你的 Wiki 和任务：`zhiqu mcp`

`zhiqu mcp` 是一个 MCP 服务器（stdio）。接上之后，Claude Code、Claude 桌面版、Cursor 这些客户端能用你在知趣·象限里的东西：

| 工具 | 做什么 |
|---|---|
| `search_wiki` / `read_wiki_page` | 查、读知识 Wiki |
| `create_wiki_patch` | 改 Wiki —— **只生成草稿**，到网页「知识 Wiki → 待合入变更」里确认 |
| `list_tasks` | 读没做完的任务（带 `#编号`）。网页「设置 → AI 模型」里关了「让 AI 读我的任务」时读不到 |
| `update_task_status` | 把一条任务标成待办 / 进行中 / 已完成 —— **直接生效** |
| `create_study_plan` | 新建任务 / 例行计划 —— **只生成草稿**，到网页 AI 助手里确认 |
| `read_memory` / `propose_memory` | 读长期记忆 / 提议新的（草稿） |

先 `zhiqu login` 登录一次（令牌存在 `~/.zhiqu/config.json`，`zhiqu mcp` 用的就是它）。连的是登录时的那台服务器 —— 默认是 `https://zhiqustudy.com`；
连本机的 Windows 桌面应用就 `zhiqu login --server http://127.0.0.1:47615`，那就要开着它（Mac 版桌面应用打开的就是网站，不用另连）。

**Claude Code**（所有项目都能用）：

```bash
claude mcp add --scope user zhiqu -- zhiqu mcp
```

**Claude 桌面版**：`~/Library/Application Support/Claude/claude_desktop_config.json`（Windows 是 `%APPDATA%\Claude\claude_desktop_config.json`）。
图形界面的应用不一定找得到 `zhiqu`，`command` 写 `which zhiqu` 给出的完整路径：

```json
{ "mcpServers": { "zhiqu": { "command": "/opt/homebrew/bin/zhiqu", "args": ["mcp"] } } }
```

**Cursor**：`~/.cursor/mcp.json`，内容同上。

一个 MCP 连接算一段会话：它生成的草稿挂在网页 AI 助手里一个「MCP · 客户端名」的 Notebook 上。每个工具第一次用时客户端会问你允不允许；
读的那几个标了只读（`readOnlyHint`），客户端可以据此少问几次。

## 开发

```bash
npm test                     # node --test；与服务器端共用的一致性用例也在里面
```
