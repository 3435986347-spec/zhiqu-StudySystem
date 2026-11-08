# 第一百二十三轮（2026-11-08）：子 agent（Codex 同级第 8 步）

## 由来
用户：「好的，接着做第八步」—— `docs/codex-parity-plan.md` 第 8 步：子 agent，只读探索、干活两种，继承权限，有并发和预算上限，端到端验。

Codex 的做法（官方文档 [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)；原地址 developers.openai.com/codex/subagents 现在 308 到这里）：
- 工具 `spawn_agent`、`send_input`、`resume_agent`、`wait_agent`、`close_agent`，默认开着；内置 default / worker / explorer 三种。
- 子 agent 继承当前的沙箱和审批设置；explorer 的「只读」只是说明里叫它别改，**没有单独的只读沙箱**。
- 只在用户直接要求、或者项目 / skill 的说明要求时才派；文档说子 agent 比单个 agent 费 token。
- 交互模式下子 agent 的审批会冒到界面上；非交互时直接失败、把错误交回主 agent。
- 并发上限文档没写数（维护者在 issue 里说默认 6），嵌套深度、时限、token 预算文档里都没有。

## 计划
1. 命令行（`zhiqu-cli/src/subagents.js`）给主 agent 四个工具：`spawn_agent`（role = explorer / worker，task）、`wait_agent`、`send_input`（给做完的再交代一件事，它记得之前读过的）、`close_agent`。子 agent 在单独的上下文里跑同一个循环（`runTurn`），和主 agent 并行，做完只交回一段结论。
2. **继承权限，不超过主 agent**：explorer 一律只读（plan 档的工具、只读沙箱 —— 比 Codex 严：是代码保证，不是说明里叫它别改）；worker 和主 agent 同一档，plan 档 / exec 只读时不能派 worker。「本会话都允许」两边共用。子 agent 不能再派子 agent（深度 1），不给后台命令（活多久、谁来停说不清）。
3. **上限**：同时在跑的（默认 3：服务器的模型网关一个用户一分钟 60 次）、一句话里派的个数（默认 8）、一句话里子 agent 一共花的 token（默认 200 万，到了就停下所有在跑的、不再派）、每个的轮数（explorer 30、worker 和主 agent 一样）。只认用户级配置 `~/.zhiqu/config.json` 的 `agents`，项目里的 `.zhiqu/settings.json` 不能替用户调高花费。
4. **并行的安全**：
   - 每个 agent 自己一份「读过什么」：原来是一份共用的，worker A 写完，B 没读过新版本也算「读过」，能拿旧内容整份盖掉 A 的改动。
   - 确认一次只问一个：原来两个确认同时在等时，屏幕上是后一个问题、回答交给前一个（看着「写入 b.js？」按 y，批准的是 a.js）。做进 `Ui.choose`，主 agent 也一样排队；Ctrl+C 之后还排着的一律按不同意，不再弹出来。
   - 一句话结束时还在跑的子 agent：推一次「wait_agent 拿结果」，还不等就停掉，不留到下一句（Codex 有完成了的子 agent 一直占名额的 issue）。
5. `/agents` 看这段会话里的子 agent（在跑 / 做完 / 停了，花了多少），`/agents <编号>` 看它的结论；`/new` 清空。用量算进 `/usage`。
6. 网页的代码模式这一轮不给（网页上还没有显示子 agent 的地方），工具清单里就没有 —— 下发的和能执行的同一份。
7. 验：假模型真 HTTP 的端到端（两个 explorer 并行、worker 改文件、并发 / 个数 / 预算上限、ask 档两个 worker 同时要确认、Ctrl+C）；真浏览器里点一遍（这一轮动的是命令行，网页没有改动，照规矩在网页上看一眼代码模式的工具清单没变）。

（这一轮的计划最早写成第一百二十轮；做到一半用户插了几件更急的 —— 线上卡死、安装包、命令行默认连网站和发布 npm、「已写入文件」其实没写、RAG —— 半成品先收起来，排到这一轮接着做。）

## 结果

- `zhiqu-cli/src/subagents.js`：`spawn_agent` / `wait_agent` / `send_input` / `close_agent`；子 agent 跑同一个 `runTurn`、单独的上下文（看不到主 agent 和用户的对话）、做完只交回一段结论（`wait_agent` 拿，最多 8000 字）。explorer 是 plan 档的工具 + 只读沙箱（代码保证的，不是说明里叫它别改）；worker 和主 agent 同一档，plan 档 / exec 只读时派不了；「本会话都允许」共用；子 agent 不能再派、不给后台命令；`send_input` 时跟着主 agent 现在的模型、档位走。
- 上限（只认 `~/.zhiqu/config.json` 的 `agents`）：同时 3 个、一句话 8 个、一句话 200 万 token（每次子 agent 调完模型就算，到了就停下所有在跑的、不再派，主 agent 收到为什么）；explorer 30 轮。子 agent 的用量算进 `/usage`。
- 一句话收尾时还有在跑的：推一次「用 wait_agent 拿结论」，还不等就停掉、终端里说一句，不留到下一句；Ctrl+C 连子 agent 一起停。
- 并行的安全：每个 agent 自己一份「读过什么」（`childLocal`：原来共用一份，A 写完 B 没读过也算读过，能拿旧内容整份盖掉 A 的）；终端的确认一次只问一个（`Ui.choose` 排队；原来两个问题同时挂着时屏幕上是后一个、回车交给前一个），Ctrl+C 之后还排着的按不同意；子 agent 停下了就不再问、问出去回答回来时已经停了也按不同意（不然停掉的子 agent 还会写文件）。
- `/agents`、`/agents <编号>`；`/new`、`/resume` 换会话时清空；`/review` 的单独上下文里不派。网页的代码模式这一轮不给（宿主里没有 `ctx.agents`，下发的工具里就没有）。
- 判据（`test/subagents.test.js` 16 条 + review、code-host 各 1 条）：两个 explorer 真并行（同时在途 ≥ 2）、只读的真只读、权限、上限、预算、收尾、Ctrl+C、send_input / close、各自一份读过什么、确认排队（真终端）、用户级配置、`/agents`、带系统沙箱时子 agent 没有后台命令、真命令行入口（`zhiqu exec`）、网页没有。扰动 31 个全红。
- 没做的：真模型爱不爱用、用了有没有更好（要花钱，没问）；网页里显示子 agent。
