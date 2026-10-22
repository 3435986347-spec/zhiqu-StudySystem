# 第三十四轮（2026-10-04）：任务页拆成模块（方案第 4 步的第五块）

## 由来
方案第 4 步接着一页一页搬。任务页（`tasks.html`）：筛选列表、加载更多、切状态、删除；新建 / 编辑打开**任务表单** —— 表单看板也用（「新增任务」），
所以表单（`openTaskForm` 及 `taskFormPayload` 等）这一轮留在壳里，经 `zqShared` 给任务页；看板拆的时候再一起看它该住哪。

## 计划（开工时）

1. **挪**：`bootTasks`（含里面的 `loadTasks`）、`TASK_PAGE_SIZE`、`loadMoreTasks`、`renderTaskRows`、`deleteTask`、`cycleTask` 进 `pages/tasks.js`。
   列表的状态（`state.tasks` / `taskQuery` / `taskTotal`）照旧放在壳的 `state` 上 —— 表单编辑时要从那里找原来那条任务。
2. **一处必须改的**：`openTaskForm(id, onSaved)` 保存之后默认刷新任务页（`onSaved || bootTasks`）—— 任务页挪走之后壳里没有 `bootTasks` 了。
   改成「谁打开谁说保存后刷新什么」：任务页两处调用把自己的 `bootTasks` 传进去，看板照旧传 `bootDashboard`；壳里不再有默认值。
   这是挪过来的代码里唯一改动的地方（两个调用点各多一个参数）。
3. **先查判据**：`TaskFormTest`（新建 / 编辑都打开表单）、`DataVolumeFrontendTest`（加载更多核对筛选条件）、`LatestResponseTest`（已扫全前端）。
4. **暴力测试**：真浏览器里来回改筛选（乱序回来的不画）、加载更多期间换筛选、连点状态、新建 / 编辑 / 删除。

### 怎么验
真浏览器走一遍；全量通过、扰动见红；桌面应用重新打包。

## 结果（2026-10-04）

照计划做完。

- **挪**：任务页进 `pages/tasks.js`，壳 5070 → 5006 行。列表的状态照旧在壳的 `state` 上（模块 `bind` 了 `state`）。`zqShared` 补上 `qKey`、`pLabel`、`openTaskForm`。
- **唯一改动的地方**：`openTaskForm` 不再默认刷新任务页（`onSaved || bootTasks` → `if (onSaved) await onSaved()`），任务页两处调用传自己的 `bootTasks`，看板照旧传 `bootDashboard`。
  `TaskFormTest` 加了一条：全前端每一处打开任务表单都要说保存之后刷新什么（没有默认值之后，漏传就是「保存了、列表还是旧的」）。
- 跟着改的判据：`TaskFormTest`（新建 / 编辑读模块；「不许只问一个标题」改扫全前端）、`DataVolumeFrontendTest`（加载更多读模块）。

**真浏览器**（`zhiqu_verify`）：19 条任务；连点三次「查询」（象限 1 → 2 → 全部）停在最后一次（19 条）；只看「重要不紧急」15 条、徽章都是它；
新建（表单 → 列表 20 条）、编辑（表单里带着原来的标题 —— 从壳的 `state.tasks` 找到的 → 改名后列表跟着变）、切状态（待办 → 进行中）、删除（回到 19 条）；
看板上「新增任务」保存后看板重新取了一次（`/dashboard/overview` 1 → 2），那条测试任务随后删掉。加载的是 `pages/tasks.js?v=20261004-tasks`。
**计划里的「加载更多期间换筛选」没在浏览器里演**：这个账号只有 19 条，不到一页（100 条）、不出「加载更多」—— 那一条由 `DataVolumeFrontendTest.加载更多认筛选条件` 管。

**判据**：扰动 8 个全红（模块表少一项、任务页 / 看板打开表单不说刷新什么、加载更多不核对筛选、列表不问 `current()`、`zqShared` 少给 `openTaskForm`、
模块没解构 `pLabel`、模块里取全部任务），逐条看过红的原因。

**验**：全量 959 / 0 / 0 / 0（开着 Docker），第一遍就是绿的；桌面应用重新打包。
