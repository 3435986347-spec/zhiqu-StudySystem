# 干活中途补充（steer）（2026-11-17）

用户 2026-11-17：「我现在想改造成能够在模型处理的时候发信息，作为一个引导或者补充，然后他运行完当前的命令或者是思考完能接收到，而不是现在只能等他一轮所有结束才能接收到我接着发的内容，后面的都在排队。」

四件「要你定」用户 2026-11-17 都按推荐定了（见末尾）。一步一轮做，做完更新「进度」。

## 一句话

一轮回答里本来就有天然的「缝」：**每一次模型调用说完、每一批工具跑完**。现在这些缝上什么都不看，用户中途说的话要等整轮结束（命令行、桌面、网页代码模式），或者只在「最终写作动笔之前」并一次（网页普通聊天，第一百三十三轮）。
改法是给一轮配一个**收件箱**：用户中途说的话进收件箱，循环每走到一条缝就把收件箱倒进上下文（一条标明「中途补充」的 user 消息），模型下一次调用就看得到。命令行、桌面、网页代码模式跑的是同一份 `runTurn`，**内核只改一处**，三个入口各自只做「把话送进收件箱」这一段。

## 现在是什么样（读代码看的）

| 入口 | 谁跑循环 | 生成中再发一句会怎样 | 代码位置 |
|---|---|---|---|
| 命令行 | `cli.js` → `agent.js` 的 `runTurn` | 进 `ui.queue`，这一轮**整个**结束后作为下一轮发出；Ctrl+C 时放回输入框 | `ui.js` `handleLine` / `enqueue` / `takeQueued` / `unqueue`；`cli.js` `readInput` |
| 桌面应用 · 代码模式（选了文件夹） | 外壳 `LocalAgent.swift` 起 `code-host.js`（本机）→ `runTurn` | 进页面的排队条；「立即」直接被拒（`sendQueuedNow`：`info.kind === 'desktop'` → 排到队首） | `ai-assistant.js` `sendQueuedNow` / `pumpSendQueue`；`PageView.swift` 的 `run / resume / ack / stop` |
| 网页 · 代码模式（服务器跑的、生成到产物） | 后端 `JsCodeAgent` 起 `code-host.js` → `runTurn` | 「立即」→ `POST /api/ai/runs/{id}/say` → `StreamState.inject`，**只有最终写作用得上**；而代码模式的最终回答就是 agent 的结论、不再调模型，于是补充的话**一律没用上**，只弹一句「没赶上这一轮」 | `AiServiceImpl.FinalWriterRunner`（约 1828 行）、`ChatRunHub.say` |
| 网页 · 普通聊天 | `AiServiceImpl` 的阶段流水线（检索、Wiki 工具 agent、写最终回答……） | 「立即」在最终写作动笔前能并进去；动笔后返回 `next`，留在队首 | `StreamState.inject` / `beginFinalWriting` |

关键事实：

1. **循环里的缝都在 `runTurnBody` 一个函数里**（`agent.js` 约 1480–1700 行）：
   - 缝 A：一批工具全部回完（含截图那条 user 消息）之后、下一次 `callModel` 之前；
   - 缝 B：模型这次没调工具（要收尾了），`pendingNudge` 那一段 —— 现在会 `break`；
   - 缝 C：被截断要续写（`finishReason === 'length'`）、推回去（清单 / 核对 / 子 agent）的那几个 `continue`。
2. **工具结果必须紧跟 `tool_calls`**（OpenAI 规矩，第一百三十五轮截图那次踩过）：补充只能插在**整批**工具结果之后，不能插在两个工具之间。
3. **一次模型调用之内没有缝**：思考和回答是同一个请求的流。所谓「思考完再接收」，在这里只能是「这次调用说完」—— 要更早就只能打断这次调用、带着补充重新发（见「要你定」3）。
4. Anthropic 那边连着两条 user（`tool_result` 一条 + 补充一条）：`direct.js` 的 `toAnthropicMessages` 不合并、靠 API 自己合；后端 `AnthropicFormat` 会合并。截图那条已经是这个形状，能用，但要有判据钉着。
5. `code-host.js` 的桥认不出的消息**直接 `fail` 停掉整轮**（`createBridge` 的 `lines.on('line')`）：新消息类型必须宿主、后端、外壳一起上，旧宿主收到 `say` 会把这一轮弄死。后端和宿主在同一个 JAR 里，桌面外壳和宿主在同一个安装包里 —— 版本天然对齐，但要在判据里写明。
6. 历史只追加（缓存、第一百零四轮）：补充是**追加**一条 user 消息，不改前面任何一条，缓存不受影响。

## 设计

### 内核：一轮一个收件箱（`agent.js`）

```
ctx.inbox = {
  push(text, meta)   // 入口调用：命令行回车、宿主收到 say。关了就返回 false
  take()             // 循环在缝上调用：取走全部，合成一条
  close()            // 这一轮要收尾了：之后 push 一律 false；返回没取走的（交回给入口，变成下一轮）
  size()
}
```

- **合成一条**：几句一起到的合成一条 user 消息，开头固定一句标记：
  `（用户在你干活的过程中补充了下面的话。它比原来的要求新：有冲突以它为准；和原来的要求不冲突就一并做到。做到一半的事情先想清楚还要不要接着做。）`
  不标的话模型会把它当新问题、丢下手上的活（第一百三十三轮最终写作那段同样的理由）。
- **record 的 origin 记成 `'steer'`**，并 `noteSaid(ctx, text, { steer: true })` —— 会话记录（`.zhiqu/sessions/*.jsonl`）、`/resume`、`catchUp` 都看得出「这句是中途说的」。
- **缝 A**：工具那一批（和截图）记完之后 `drainInbox(ctx)`。
- **缝 B**：模型这次没调工具、要收尾时，先看收件箱：有话 → 这次的回答照常记进历史（它是一段「阶段性结论」），追加补充，`continue`。不 break。`finalText` 只认**最后**那句（`code-host.js` 的 `lastSaid` 本来就是这么取的，第一百二十八轮）。
- **缝 C**：几个 `continue` 之前也倒一次（被推回去重写时正好带上用户的新话）。
- **重复检测清零**：倒进过补充，`ctx.repeat = null` —— 用户说了新话之后同一个调用再发一次是合理的，不该算「原地打转」。
- **状态卡**（第一百三十八轮）：`work.noteSteer(text)` 把补充记进卡里的「要求」一栏。压缩会把中间的 user 消息摘掉，卡不会 —— 不记的话压缩一次，用户中途改的要求就没了。
- **收尾 `close()`**：`runTurnBody` 的 `finally` 里关箱，没取走的（例如最后一刻才到）交回入口，入口把它变成下一轮的第一句。被 Ctrl+C / 停下时同样交回（命令行放回输入框，和现在 `unqueue` 一致）。
- **子 agent 不开收件箱**：补充只给主 agent；主 agent 看到了自己决定要不要转给子 agent（`send_input` 一类的事以后再说）。
- **长度上限**：一句 4000 字（和 `/say` 一致），一次倒入合计 8000 字，超了截断并在消息里说「后面的截掉了」。

### 命令行（`ui.js` / `cli.js`）

- 生成中回车：默认**补充给这一轮**（`ctx.inbox.push`），活动区上方留一行灰字 `↳ 补充：…（下一步生效）`；被倒进上下文时那一行变成 `↳ 补充：…（已送达）`。
- 想留到下一轮的：`Tab` 排队（还是现在的 `ui.queue`）—— 键位见「要你定」1。
- 正在问确认（「写入 a.js？」）时打的字照旧是回答，不进收件箱（`waiters` 那一支不动）。
- 打 `/` 开头的命令照旧排队，不补充。
- Ctrl+C：没送达的补充和排队的一起放回输入框（`interruptHandler` 里 `ui.unqueue()` 之前先把 `inbox.close()` 交回的并进去）。
- 管道输入、`zhiqu exec`、`-p`：没有「中途」，不开收件箱。

### 宿主协议（`host/code-host.js`）

- 桥认一种新消息：`{ type: 'say', id, text }`（后端和外壳 → 宿主）。收到就 `ctx.inbox.push`，回一行 `{ type: 'say_ack', id, accepted }`。箱子关了（这一轮在收尾）回 `accepted: false`。
- 被倒进上下文时发一条 trace 步骤 `{ kind: 'steer', text, ... }`（`steps.js` 加这个形状）—— 网页的步骤列表、存库的 `steps_json` 里都有它，排在它被读到的那个位置，刷新后照样在。
- `result` 多一个字段 `leftover: [text…]`：收尾时没取走的补充。
- 判据写明：`say` 只有新宿主认；后端和宿主同 JAR、外壳和宿主同安装包。

### 网页 · 代码模式（后端）

- `JsCodeAgent.run` 开着宿主时，把「往宿主说一句」登记到这一轮上：`StreamState` 加一个 `codeSay` 句柄（`text -> boolean`）。
- `StreamState.inject` 改成三段：
  1. 代码 agent 正在跑 → 交给 `codeSay`（写一行 `say` 给宿主，等 `say_ack`，最多 2 秒；读 `say_ack` 的是现在那个读循环，用一个 `CompletableFuture` 交接）；
  2. 还没到最终写作 → 照旧存进 `injected`；
  3. 最终写作已动笔 → `false`（`next`）。
- 宿主交回的 `leftover` → 发事件 `message.steer.returned`，页面把它们放回队首、这一轮结束就发。
- `FinalWriterRunner` 代码模式那一段「你补充的话没赶上这一轮」的提示，只在真有 leftover 时才说。
- `ChatRunHub.say` 返回值不变（`current` / `next`），页面不用改协议；`message.injected` 改成「已送达」时才发（宿主那条 steer 步骤到了），而不是「收下了」就发 —— 收下和模型看到是两回事。

### 网页 · 普通聊天（后端 Java 流水线）

- 已有的「最终写作前并进去」保留。
- `WikiToolAgent` 的两个循环（各最多 4 轮）在轮与轮之间读 `StreamState` 的待补话（同一份 `injected` 列表，读了标记已送达），这样「帮我改 Wiki」途中说「标题别动」能赶上。
- 其余阶段（检索、核对）都是一次调用，没有缝，不做。

### 网页 · 页面（`ai-assistant.js`）

- 生成中按发送：默认**补充给这一轮**（走 `/say`），排队条那一行显示「补充 · 待送达」，送达后从排队条消失、出现在回答的步骤里（`↳ 你补充：…`）；`next` / 被交回的显示「排到下一轮」。
- 排队条每一行保留「排到下一轮 / 立即补充」的切换和「×」—— 默认是哪个见「要你定」2。
- 桌面里（`info.kind === 'desktop'`）不再直接拒绝：走新加的 `localCall({ action: 'say', runId, text })`。外壳是旧版本（回「认不出的请求」）时退回排队，说一句「更新应用后才能中途补充」。
- 刷新 / 接回（第一百三十三轮的 `reattach`）：送达的补充是步骤的一部分，重放里就有；待送达的存在 sessionStorage 的队列里（和现在一样）。

### 桌面外壳（`PageView.swift` / `LocalAgent.swift`）

- `PageView` 加一个 `case "say"`：查 `runId` 是正在跑的那一轮，交给 `agent.say(text)` → `send(["type": "say", ...])`。
- `LocalAgent.handle` 认 `say_ack`（目前只认 `step / trace / result / fatal`，其它的丢 —— 要加，不然页面永远等不到确认）。
- **外壳改了要重打桌面应用**才到用户手里；宿主在安装包里，同一次重打。

### 不做的（这一版）

- 不打断正在进行的模型调用（除非「要你定」3 选了打断）。
- 不打断正在跑的命令：长命令（`shell` 前台）跑着的时候补充要等它跑完；活动区那行灰字写「命令跑完就送到；急的话按 Esc / 停止」。
- 子 agent 不收补充。
- 跨后端重启不保留待送达的补充（和第一百三十三轮的 run 一样在内存里）。

## 步骤（一步一轮）

| 步 | 内容 | 主要改动 | 判据（每条都要见过红） | 进度                                                         |
|---|---|---|---|--------------------------------------------------------------|
| 1 | **内核**：收件箱 + 三条缝 + 记录 + 状态卡 + 收尾交回 | `agent.js`、`steer.js`、`state.js`（状态卡）、记录里另记 `steer` 行 | `test/steer.test.js`（假模型）：工具跑到一半 push → 下一次请求里补充排在**整批** tool 结果和截图之后；模型说完结论那一刻 push → 不收尾、接着调一次；收尾后 push 返回 false、交回；Ctrl+C 交回；重复计数清零；压缩后状态卡里还有那句；子 agent 没有 inbox。`toAnthropicMessages` 的形状判据（tool_result 后跟文本）。扰动：去掉缝 A 的 `drainInbox`、去掉缝 B 的检查 | 第一百五十轮做完（缝 A / C 合成循环顶上一处；11 处扰动见红） |
| 2 | **命令行交互**：生成中回车 = 补充、Tab = 排队（或按用户定的键）、灰字送达状态、Ctrl+C 放回、`/resume` 看得出 | `ui.js`、`cli.js`、`render/` | `ui` 的判据：live 时回车进 inbox 不进 queue；问确认时回车是回答；`/` 开头进 queue；Ctrl+C 两者都放回。真终端里跑一遍（第十三轮那套）。**发 npm（0.2.6）** | 第一百五十一轮做完（npm 0.2.6 用户发）                       |
| 3 | **宿主协议 + 网页代码模式**：`say` / `say_ack` / steer 步骤 / `leftover`；后端转发、`inject` 三段、`message.steer.returned`；页面送达状态 | `code-host.js`、`steps.js`、`JsCodeAgent.java`、`AiServiceImpl`（`StreamState`）、`ChatRunHub`、`ai-assistant.js`、`zhiqu-ui.css` | 宿主：`say` 不再 fail、关箱后回 false、leftover 进 result（node 判据）。Java：`JsCodeAgentSteerTest`（假宿主：say 写到 stdin、ack 交接、2 秒超时回 next）、`ChatRunHubTest` 加「代码 agent 在跑时走 codeSay」。前端：`stream-reattach-check.js` 加 steer 步骤、returned 放回队首。扰动各一。**换缓存令牌**、部署服务器 | 第一百五十二轮做完（已部署）                                 |
| 4 | **桌面本机**：`PageView` 的 `say`、`LocalAgent` 认 `say_ack`、页面走 `localCall` | `PageView.swift`、`LocalAgent.swift`、`ai-assistant.js` | Swift 检查程序（`DesktopLocalRoundsTest` 那种编一个小程序）：`say` 交给正在跑的那一轮、`runId` 不对拒绝、`say_ack` 送回页面；`ws-bar-check.js` 的假 `zqLocal` 桥加 `say`。**重打桌面应用**、放上服务器 |                                                              |
| 5 | **普通聊天**：Wiki 工具 agent 轮间读补充；最终写作那段沿用；送达状态和代码模式同一种显示 | `WikiToolAgent.java`、`AiServiceImpl` | `WikiToolAgentSteerTest`：第 2 轮之前 inject，第 2 轮请求里有它；已送达的不在最终写作里再并一次（只并一次）。扰动 |                                                              |
| 6 | **暴力测试**：真浏览器、桌面、命令行三处狂发、连着补 10 句、补在最后一刻、补完立刻停、刷新接回、长命令跑着时补、Anthropic / DeepSeek 两种真模型各一遍（花钱的先问） | 只修出来的问题 | 照第一百四十八轮那份清单的写法 |                                                              |

每一步收口按惯例：`docs/rounds/round-NN.md` 存计划和结果、`docs/rounds/README.md` 和 `CLAUDE.md` 末尾各加一行。

## 风险

- **补充在模型写完结论之后、宿主交回 result 之前到**：缝 B 已经过去、箱子还没关 —— 这一刻的 push 必须要么被取走、要么被交回，不能丢。做法：`close()` 和缝 B 的检查在同一处（循环出口）完成，判据专门压这个时刻。
- **补充让一轮变得没完没了**：用户连着补，模型连着做。不设上限（用户 2026-11-12 去掉了轮数限制），但每次倒入在步骤里可见，停止按钮照旧有效。
- **模型把补充当新任务、丢下做到一半的改动**：靠那句固定标记 + 状态卡；第 6 步用真模型看一遍，不对再改措辞（改措辞是改系统提示的追加部分，不是改冻结的系统提示）。
- **代码模式 `say_ack` 等待阻塞 HTTP 线程**：最多 2 秒；宿主没回就当 `next`（话留在队首，不丢）。
- **旧外壳 + 新页面**：页面先试 `say`，「认不出的请求」就退回排队，不报错。

## 要你定（2026-11-17 用户：四件都按推荐）

1. **命令行生成中按回车**：
   - A（推荐，和 Codex 一样）：回车 = 补充给这一轮，`Tab` = 排到下一轮；
   - B：保持回车 = 排队，另用一个键（如 `Ctrl+J`）补充。
2. **网页生成中按发送**：
   - A（推荐）：默认补充给这一轮，排队条里可以改成「排到下一轮」；
   - B：保持默认排队，点「立即」才补充（就是现在的样子，只是「立即」真的能送达了）。
3. **补充到达时模型正在一次调用里（思考 / 写字）**：
   - A（推荐）：等这次调用说完再送（不浪费已经花的 token，命中缓存后重发也不便宜多少）；
   - B：模型还在思考、一个字都没输出时就打断这次调用、带上补充重新发；已经开始输出就等。
4. **模型已经写出结论、补充还没被读到**：
   - A（推荐）：不收尾，带着补充接着做，最后那句才是结论；
   - B：这一轮照常结束，补充自动作为下一轮的第一句发出。
