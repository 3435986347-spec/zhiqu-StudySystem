# 第三十五轮（2026-10-04）：看板拆成模块（方案第 4 步的第六块）

## 由来
方案第 4 步接着一页一页搬。看板（`dashboard.html`）：四个数、例行完成进度、一周日历、今天、四象限摘要、临近 DDL、番茄钟的任务下拉和今日计数。

## 计划（开工时）

1. **挪**：`bootDashboard`、`populatePomoTasks`、`renderWeek`、`renderToday`、`renderQuadrants`、`renderDeadlines` 进 `pages/dashboard.js`，代码一个字不改。
   **留在壳里的**：番茄钟的待补记（`recordPomodoro` / `catchUpPomodoros`，每一页都在补记）和 `updatePomoCount`（它是待补记的一部分：记完一个番茄钟时壳要刷新这个数；
   页面上没有那一格时它什么都不做）；任务表单（任务页也用）。`state.weekOffset` 照旧在壳的 `state` 上。
2. **零点重新取数据**：看板是 `DAY_RELOAD` 里最后一个页面 —— 模块导出 `dayReload`，壳里的 `DAY_RELOAD` 和那一支删掉（只剩一套机制）。
3. **先查判据**：`MainFlowWalkthroughTest.看板`、`MobileLayoutTest.看板列表收住原文`、`FrontendClockTest.接线`（看板那几句；`initAuth` 那句还在壳里）、
   `pomo-outbox-check.js`（拿 `function renderWeek(` 当待补记那一段的结尾来抠 —— 看板挪走之后要换一个结尾）。
4. **暴力测试**：真浏览器里换周来回点、新增任务、打卡、番茄钟记一个（含断网时先存在设备上、网回来补记）、过零点。

### 怎么验
真浏览器走一遍；全量通过、扰动见红；桌面应用重新打包。

## 结果（2026-10-04 ～ 10-05）

照计划做完。

- **挪**：看板进 `pages/dashboard.js`，代码一个字没改。`zqShared` 补上 `weekRange`、`zoneNote`、`updatePomoCount`。
- **零点重新取数据只剩一套**：看板导出 `dayReload`，壳里的 `DAY_RELOAD` 表和那一支删了。`PageModulesTest.零点重新取数据` 改成：壳里不许再有 `DAY_RELOAD`；
  「今天」要跟着走的页面（看板、例行计划 —— `DAY_PAGES`，就是原来那张表的内容）由 node 真 import、核对导出了 `dayReload[页面]`。
- `pomo-outbox-check.js` 原来拿 `function renderWeek(` 当待补记那一段的结尾来抠 —— 改成抠到 `catchUpPomodoros` 自己的结尾，不再依赖后面是谁。
- 跟着改的判据：`MainFlowWalkthroughTest.看板`、`MobileLayoutTest.看板列表收住原文`、`FrontendClockTest.接线`（看板那几句读模块；「不许拿浏览器的日期打卡」扫全前端）。

**真浏览器**（`zhiqu_verify`）：四个数、日期（服务端那一行）、7 天日历、今天 6 条、番茄钟下拉 9 项、今日计数；换周连点「下周、下周、上周」停在 10/05–10/11、「本周」回来；
今天里一条例行计划「完成」→ 例行完成 0/2 → 1/2、进度条 50%（先点到的是一条任务的「完成」—— 那条测试任务被标成了完成）；
记一个番茄钟（壳的 `recordPomodoro`）→ 看板重新取了一次、「今日：2 个」→「3 个」、「今天第 4 轮」；**过零点**（把 `Date.now` 拨快一天、等过一分钟的检查）→ 看板重新取了一次。
加载的是 `pages/dashboard.js?v=20261004-board`。番茄钟断网先存设备上、网回来补记那一段没动（还在壳里），由 `pomo-outbox-check.js` 管。

**判据**：扰动 8 个全红（模块表少一项、看板不导出 `dayReload`、壳里又有一套 `DAY_RELOAD`、看板打开表单不说刷新什么、进度条 `if (false)`、打卡用浏览器的日期、
`zqShared` 少给 `updatePomoCount`、模块没解构 `weekRange`），逐条看过红的原因。

**验**：全量 959 / 0 / 0 / 0（开着 Docker），第一遍就是绿的；桌面应用重新打包。
