# zhiqu

知趣·象限的命令行 coding agent。**循环和工具跑在你的电脑上**（读、搜、写、跑命令都在本机的工作区里），
**模型、登录和学习数据在服务器上**（API Key 只在服务器，命令行拿不到）。

```bash
npm i -g zhiqu          # 或者在仓库里：cd zhiqu-cli && npm link
zhiqu login             # 浏览器里确认，命令行不接触密码
cd 你的项目
zhiqu                   # 开始
```

## 三档权限

| 档位 | 做什么 | 切换 |
|---|---|---|
| `plan` | 只读、只搜、只出计划；计划交上来，你批准了才开始改 | `/mode plan` 或 `--mode plan` |
| `ask` | 每次写文件先给 diff、每条命令先给命令行，问 y / n（`a` = 本会话都允许这一类） | `/mode ask`（默认） |
| `auto` | 写文件、跑命令都不再问，**做完再告诉你**（每一步照样显示） | `/mode auto` |

三档的安全规则一样，`auto` 免的是「问」，不是「规则」：

- 路径不出工作区（`../`、绝对路径、中间某段是指向外面的软链都拒）；不跟随软链；
- 不读 `.env`、`*.pem`、`id_rsa` 这类文件（扩展名白名单）；
- 改一个已存在的文件之前必须先读过它，读过之后被你在编辑器里改了就要重读；
- 命令只接受「命令名 + 参数」，不经过 shell；不接受行内代码（`-c`、`-e`、`--eval=`、`node -pe`、`python3 -Bc`……）和 `npm exec`；
- 子进程拿不到你的环境变量（令牌、云凭据）；超时连同它起的子进程一起杀掉；输出有上限。

这些规则与服务器端的工作区是同一套，两边共用 `conformance/workspace-rules.json` 这份一致性用例。

## goal 模式

```
/goal 做一个能跑的贪吃蛇，放在 game/ 下，并自己验证      会话里设目标
zhiqu --goal "修好所有失败的测试" --mode auto < /dev/null   无人值守（退出码 0 达成 / 2 卡住 / 3 轮数用完）
```

设了目标之后，它是这段会话的最高优先级：模型不能说「接下来你可以……」就停，只有宣告
**已达成**（附上它亲自验证过的证据）或 **卡住了**（说清楚需要你做什么）才会停；宣告达成之后还要过一道独立核对，
核对不过就带着缺口接着做。有轮数上限，Ctrl+C 随时停，`/goal continue` 接着追，`/goal clear` 放下。

## 命令

```
zhiqu -p "帮我写个贪吃蛇"    只跑这一句，打印回答后退出
zhiqu -c                    接着上一段会话
zhiqu --resume [id]         挑一段会话接着做
zhiqu login [--server URL]  登录；--token zqp_… 用个人中心签的令牌
zhiqu logout | whoami | models
```

会话里：`/goal`、`/mode`、`/model`、`/resume`、`/new`、`/compact`、`/init`、`/skills`、`/mcp`、`/system`、`/usage`、`/exit`。输入 `/` 会在输入行上方弹出命令菜单：↑↓ 选、回车执行、Tab 补全后接着打参数、Esc 关掉。`/resume` 接上一段会话时会先把那段的聊天记录显示出来。

本地工具：`list_files`、`read_file`、`search`、`write_file`（新建 / 追加 / 替换一段）、`delete_file`（挪进 `.zhiqu/trash/`，能恢复）、`run_command`。模型不能改、不能删 `.zhiqu/` 与 `.git/` 里的文件。
行尾加 `\` 换行接着输入；Ctrl+C 打断正在做的事。它干活的时候输入框一直在底下：可以接着打下一句，按回车就排队，
这一轮做完自动发出。

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

**MCP**：`.zhiqu/mcp.json` 里 `mcpServers` 下每项要么是 `{"command", "args", "env"}`（stdio），要么是
`{"url", "headers"}`（HTTP）；值里可以写 `${环境变量}`。工具名会加前缀 `mcp__服务__工具`；每个工具第一次用都会问你
（`auto` 也问）；返回的内容一律当作数据，不当作指令。

**长对话**：用到模型上下文窗口的约 80% 时自动把较早的对话压成摘要（目标、决定、改过的文件、待办），也可以 `/compact`。
窗口大小在网页「个人中心 → AI 模型配置」里按模型设置。

## 对话在网页里也看得到

每段命令行会话在网页「AI 助手」里是一个 Notebook（「命令行 · 项目名 · 标题」）。让它排学习计划、记长期记忆、写知识 Wiki
时生成的都是草稿，在网页里确认之后才生效。

## 开发

```bash
npm test                     # node --test；与服务器端共用的一致性用例也在里面
```
