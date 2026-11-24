# 第一百七十一轮（2026-11-24）：长活省钱第 6 步——进程没正常结束时记下原因，下次启动直接回车接着做

[`docs/agent-efficiency-plan.md`](../agent-efficiency-plan.md) 的第 6 步（问题 H）。

## 计划

用户那段会话里进程两次中途没了（11-23 12:21、12:38），什么都没记：下次启动只能说「进程中途没了」，用户把 4087 字的终端输出整段贴进补充，只为了说「继续这个」。

## 做了什么

- 新文件 `exitlog.js`：
  - `installExitRecorder`：接得住的——未捕获的异常、终端被关（`SIGHUP`）、被结束（`SIGTERM`）——同步往会话记录写一行 `{ type: 'exit', reason, signal / error, rss, working, lastTool }` 再按规矩退（128 + 信号号；异常照旧打出来、退出码 1）。不管 `SIGINT`：Ctrl+C 是界面自己处理的打断。
  - 接不住的（`SIGKILL`、内存不够被系统杀掉）：`agent.js` 每记一次用量顺带记 `rss`，下次至少说得出最后的内存占用。
  - `lastExit` 只读记录末尾 256KB（那段会话的记录 28MB）；`exitReason` 写成人话。
- `agent.js`：`runTurn` 期间 `ctx.working = true`；`executeTool` 记 `ctx.lastTool`。
- `cli.js`：开会话后装上、各个出口卸下；`noteUnfinished` 说出原因（「终端被关掉了（SIGHUP），当时正在干活（最后一个工具 preview_page）」「没来得及记下原因……最后记下的内存占用 1.8GB」），并记下 `pendingResume`；交互循环里开工前**直接回车**就 `resumeInto` 那一段。

## 结果

- 新判据 `test/exitlog.test.js` 5 条（含真进程：真 CLI 在等模型时收 `SIGTERM` → 记录里有原因、退出码 143；再用 Python `pty` 起交互模式，提示里说出原因、回车接上那一段；没有 python3 的机器显式跳过）；`recall.test.js` 两处提示原文跟着改。
- 6 处扰动各自见红：不装 → 1 红；不说原因 → 3 红；回车不接 → 1 红；用量不记内存 → 1 红；退出码不照规矩 → 2 红；不记是否在干活 → 1 红。
- 写真进程判据时撞到的两个坑（都是测试写法，不是产品的错）：① 用 `spawnSync` 跑终端驱动会堵住测试进程的事件循环，而假服务器就在这个进程里，CLI 连它一直等到 15 秒超时；② Node 的测试运行器自己也听 `uncaughtException`，直接 emit 会把测试本身弄挂——处理函数挂在返回值上直接调。
- CLI 全量：762 项，740 过 / 22 跳 / 0 失败。
- 没发 npm、没部署：同第一百六十六轮。
