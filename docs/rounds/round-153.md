# 第一百五十三轮（2026-11-17）：干活中途补充第 4 步 —— 桌面本机

## 由来

[`docs/steer-plan.md`](../steer-plan.md) 第 4 步。第一百五十二轮网页代码模式能中途补充了，桌面应用里选了文件夹的那一轮（外壳起包里的 node 跑宿主）还是老样子：
生成中按发送照旧排队（`canSteer` 对 `kind === 'desktop'` 说不）。宿主那边 `say` / `say_ack` / `steered` / `leftover` 上一轮已经有了，缺的是外壳这一段和页面走 `localCall`。

## 要做的

- **`LocalAgent.swift`**：
  - `say(text, done)`：这一轮在跑就写一行 `{type:'say', id, text}` 给宿主，等 `say_ack` 交回 `accepted`；5 秒没回音、宿主退了都当没收下（`false`）。
  - `handle` 认 `say_ack`（交给等着的那一个，不转给页面）和 `steered`（转给页面）。**原来认不出的一律 fatal 停下** —— 宿主一说 `steered` 外壳就会把这一轮弄死。
- **`PageView.swift`**：`zqLocal` 加 `{action:'say', runId, text}` → `{accepted}`。`runId` 不是正在跑的那一轮回 `accepted:false`（不是错：页面排队）；话空 / 太长（4000 字，和 `/say` 一致）是错。`steered` 记进快照（离页回来 `resume` 照样知道哪句已经读到了）。
- **页面（`ai-assistant.js`）**：
  - `canSteer` 认桌面那一轮；`steerItem` 在桌面里走 `localCall({action:'say'})`。
  - 旧外壳回「认不出的请求」→ 排队，说「更新桌面应用后才能中途补充」。
  - `waitLocal` 收 `steered` → 送达；回放快照里的 `steered` 也算。
  - `finishDesktopTurn` 把 `result.leftover` 当「交回」：排到最前面，这一轮存完档就发。
  - 换缓存令牌。
- **重打桌面应用、放上服务器**（外壳改了要重打；宿主在包里，同一次）。页面要部署才生效。

## 判据

- `DesktopLocalAgentTest` 加一段（真起 node 跑宿主、假网关）：模型第一次调用停着时 `say` → 收下；下一次模型请求里有那句话；页面收到 `steered`；快照里有；这一轮结束后再 `say` → `accepted:false`；`runId` 不对 → `false`；空话、太长 → 错；宿主不回音 → 到点 `false`。
- `stream-reattach-check.js` 加 `checkDesktopSteer`：桌面里生成中发送走 `localCall('say')`；`steered` 送达；`leftover` 交回、排最前；旧外壳退回排队。
- 扰动各一，见红。

## 结果

桌面应用里选了文件夹的那一轮能中途补充了：生成中按发送 → 外壳交给宿主，跑完当前这一步就读到（回答里一步「你补充」）；没赶上的随结果交回、排到最前面先发。旧外壳不认 `say` 时退回排队、提示更新。

## 怎么验

- **`DesktopLocalAgentTest`** 加一段（真起 node 跑宿主、假网关：STEER-RUN 第一次模型调用停 2.5 秒）：
  收下且不到 2 秒就知道（不等模型）、下一次模型请求里有那句、结论是读到补充之后说的、页面收到 `steered`、回答里有「你补充」、`say_ack` 不转给页面、快照里有 `steered`；
  别的 runId / 收尾之后 → `accepted:false`；空话、超 4000 字 → 错；宿主不回音 → 到点 false；等着回音时宿主退了 → 马上 false。
  扰动 7 处见红：不认 `steered`（原来会被当成「要了外壳不做的事」停下整轮）、不认 `say_ack`、去掉回音超时、收尾不清空等着的、不判 runId、`steered` 不进快照、不判长度。
  「收尾不清空」第一版没有只有它照得出来的样本（超时会替它兜住），补了「等着回音时叫停、超时设 30 秒」那一条才红。
- **`stream-reattach-check.js`** 加 `checkDesktopSteer`（vm 里真跑整个页面模块）：发送走外壳 `say`、`steered` 送达、外壳没收下 → 排队、旧外壳 → 排队并提示更新、`leftover` 排最前先发、回放快照里的 `steered` 算送达。扰动 5 处见红。
- **跟着改的判据**：`AiReattachTest` 抠 `steerItem` 找 `/say` —— 挪进了 `steerCall`，改成两处都看（加上桌面的 `action: 'say'`）。
- **全量**：后端 1542 条，失败 2 条（就是上面那条和 `ClaudeMdTest` 的登记行，都已处理）；命令行 669 条，650 过、0 失败、19 跳过（bubblewrap）；评测工具 0 失败。
- 换缓存令牌 `20261117-r153`。

## 遗留

- 外壳改了：**要重打桌面应用**才到用户手里（和第 5 步一起重打、部署，见第一百五十四轮）。
