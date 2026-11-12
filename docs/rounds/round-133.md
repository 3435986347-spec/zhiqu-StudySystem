# 第一百三十三轮（2026-11-12）：回答不再绑在那条 SSE 上，「立即」改成补充信息

## 由来

用户在线上试第一百三十二轮：

- 「回答到一半我去查看索引了，回来就没了」「会回到上次回答完的状态」「还提示网络断了」
- 「不是要终止这一轮，是给模型补充信息」
- 「为什么还是提示 20 轮到达上限」
- 「为什么会显示这个文件夹还没有在选择文件夹里面选过」

## 要做的

**一轮回答不再绑在那条 SSE 上。** 现象是三件事叠出来的：页面一导航，浏览器把
`/ai/chat/stream` 那条连接关了；服务端的事件从此写进一个没人读的管子；而「这一轮还在跑」在服务端
没有任何**可以再连上来**的入口。页面回来只能重新拉消息列表，看到的是库里那一份（每 1.5 秒 /
24 字落一次），还在生成的后半截永远接不回来。

没有另造一套任务队列：生成本来就在 `CompletableFuture` 里、不依赖请求线程，断的是「事件没处可写」
和「没有重连入口」。补这两件事：

- `ChatRunHub`：每个 run 一个 `LiveRun`，事件带自增序号记在内存（4000 帧 / 2MB，超了从头丢），
  再推给当前挂着的那条连接。`emit` 任何异常都不外抛 —— 生成不能因为没人看就停下。跑完再留 5 分钟。
  收尾挂在 `streamChat` 的 leases 上：正常、业务错误、装配失败、意外异常四条路都会走到。
- `GET /api/ai/runs/stream?runId=&after=`：先按序号重放，再挂上去直播。重放和挂载在同一把锁里，
  中间插进来的事件不会两头都漏。丢过帧的先发 `stream.reset`（正文以库里的为准），不在内存里的发
  `stream.gone`（页面回去读消息列表）。归属校验在进 hub 之前 —— runId 是自增的。
- 路径用查询参数而不是 `{runId}`：`UbuntuDeployTest` 要求 Caddy 的 `@sse` 和后端每个流式接口
  逐条对上，`{…}` 那种通配对不上。
- 回答的线程池从 `ForkJoinPool.commonPool` 换成自己的 `chat-run`：那个池 JVM 里所有人共用，
  别的并行流把线程占满时一轮回答会排在后面不动。

**页面这一半的关键是「一份事件落地」。** `makeStreamApplier(st)` 同时给发送和接回用 —— 两份实现
迟早分叉，而分叉的表现就是「刷新之后和没刷新长得不一样」，正是这一轮要修的东西。发送时把 runId
记进 sessionStorage，`done` / `error` 清掉；`loadAiMessages` 末尾 `reattachRunningTurn()` 按记号
接回来，一次页面只试一次，接不上就交给轮询。`streamAiChat` 里那段读取循环抽成 `readSse`，接回那条
走同一个。

**「立即」不是打断，是补充信息。** 原来这里 `abort()` 当前这条流 —— 用户看着出来的半截回答当场
没了。现在 `POST /api/ai/runs/{id}/say` 把这句话交给 `StreamState.inject`：最终写作还没动笔就并进
这一轮的上下文（模型下一次调用看得到），已经动笔就返回 `next`，页面把它留在队首、这一轮结束立刻发。
代码模式的回答是 agent 的结论、不再调模型，补进来的话用不上 —— 那里会明说一句，不让用户以为
模型看过了。

**桌面本机那一轮的轮数。** 服务器那份 `CodeLoopBudget.EXPLICIT` 上一轮改成了 40，但桌面那一轮在
本机跑，轮数是外壳自己定的：`LocalAgent.Config.maxRounds` 一直写着 20。同一句话在网页上能做完、
在桌面上做到一半停下，停下来的理由还写着「用完了 20 轮」。改成默认 40，并留了
`defaults write com.zhiqu.quadrant maxRounds N`（1–120）。

**桌面里选完文件夹切不过去。** 选文件夹走系统的框：外壳把安全书签加进自己的列表、返回路径，而
页面手里的 `wsStatus.folders` 还是上一次的。于是选完立刻切过去，那句「root 不在 folders 里就是
没授权过」把**刚选的那个**挡了下来 —— 第一次能用（列表是空的，判据直接跳过），之后再换必报。
选完先 `refreshDesktopFolders()` 问一次外壳再切；桌面里「最近的项目」只列外壳真的授权过的
（最近列表里可能留着网页那会儿记下的服务器路径，点了也打不开）；那句话也改成能照着做的说法。

## 怎么验

- `ChatRunHubTest`（9 条）：断线照样记、按序重放、`after` 不重复、跑完带 done、没有终态说 gone、
  丢帧先 reset、补充是 current/next、收尾幂等。扰动（replay 少一帧）见过红。
- `AiReattachTest`（4 条）+ `stream-reattach-check.js`：发送和接回共用一份落地、回来真的会接、
  「立即」不再 abort；事件落地真跑（记号、增量、半截保留、reset、补充提示）。
- `DesktopLocalRoundsTest`：服务器 / 桌面 / 宿主 `Math.min(60, …)` 三个数必须对得上 ——
  桌面不能比服务器少，宿主的夹取上限也不能比桌面小。扰动（桌面改回 20）见过红。
- `ws-bar-check.js` 加了桌面两条（选完能切过去、菜单不列没授权过的），并给 `setup` 注入了一座假的
  `zqLocal` 桥 —— 原来 `inDesktop()` 恒为 false，**桌面那条路一条判据都没有**，所以这个 bug
  一直没被逮到。扰动（去掉 `refreshDesktopFolders`）见过红。
- 顺带修掉四条早就红着、只是前几轮只跑单测没跑全量所以没人发现的判据：`RequestResilienceTest` /
  `DraftsTest` 找的是 `sendAiMessage()` 的旧签名，`request-check.js` 没给 `state`，
  `CodeModeToggleWiringTest` 还钉着第一百三十一轮之前的 `codeModeOn`。

## 结果

- 全量后端：只剩 Docker / Testcontainers 那 114 条（这台机器没有 Docker）、`JsCodeAgentSandboxTest`
  （macOS 沙箱探测，老问题）、`HarnessCliNodeSuiteTest` 超时一次（CLI 那几条老的并发 / 环境问题）。
- 部署 `20261112-r141`；服务器上的 `/etc/caddy/Caddyfile` 加了 `/api/ai/runs/stream`（`deploy-from-dev.sh`
  不碰它），`caddy validate` 通过、reload，探测 403（路由通了、只是没带令牌）。备份在
  `/etc/caddy/Caddyfile.bak-20261112`。
- 排队条的内联样式挪进 `zhiqu-ui.css`（`InlineStyleRatchetTest` 的计数从 3 **降到** 2），
  「×」换成 `icon('x')`。

## 遗留

- **后端重启过，内存里的 run 就没了**，页面回落到读库 —— 那时能拿到的只有已经落库的半截，
  `InterruptedWorkRecovery` 会把它们收成「服务在回答途中重启了」。要跨重启续写，得把事件也写进库。
- 缓冲丢过帧时页面只清空本地拼的正文，等这一轮结束再对库；中间那段会缺。
- 桌面应用要重打安装包才拿到 40 轮；网页那一半（接回、补充信息、选文件夹）刷新页面就生效。
