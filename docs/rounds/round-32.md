# 第三十二轮（2026-10-04）：例行计划、专注统计拆成模块（方案第 4 步的第三块）

## 由来
方案第 4 步接着一页一页搬（第三十一轮立了「页面模块」的形状：`assets/pages/*.js` 导出 `boots`，壳按 `PAGE_MODULES` import）。
这一轮搬两页：**例行计划**（`pages/routines.js`）和**专注统计**（`pages/statistics.js`），一页一个模块。
这两页有两件后台四页没有的事，正好借它们把形状补全：
- 例行计划页开着跨过业务日期的零点时要重新取数据（壳的 `DAY_RELOAD` / `watchBusinessDay` 现在直接叫 `loadRoutines`）——
  模块要能把「零点时重新取什么」交给壳。
- 有两个 node 判据（`routine-phase-check.js`、`latest-check.js`）是**从壳的源码里抠函数**来跑的 —— 方案第 4 步要的是「测试直接 import 函数」，
  这一轮把它们改成 import 模块。

## 计划（开工时）

1. **挪**：`bootRoutines` … `createRoutineFromForm`（含 `routinePhase`、`loadRoutines`、从任务生成）进 `pages/routines.js`；`bootStatistics`、`highlightStatTab`、
   `renderQuadrantDonut`、`paintTrend` 进 `pages/statistics.js`。代码一个字不改（`bind(sh)` 解构成同名局部变量）；原来挂在壳 `state` 上、只有它们用的
   （`state.routineDrafts`）变成模块里的变量。壳给 `zqShared` 补上它们用到的（`today`、`latestOnly`、`keepDraft`、`normalizeTask`、`qLabel`、`sLabel`）。
2. **零点重新取数据**：模块导出 `dayReload[页面]`，壳加载页面模块之后接到 `watchBusinessDay` 上（看板还在壳里，照旧走 `DAY_RELOAD`）。
3. **测试直接 import**：模块导出 `routinePhase`、`paintTrend` 和 `bind`（测试用假的 `sh` 注入 `api`、`$`）；`routine-phase-check.js`、`latest-check.js` 改成 import；
   `freqLabel` 还在壳里，照旧从壳里取。
4. **先查判据**（第三十、三十一轮各有几条判据在全量时才红，都是搬家后还读壳）：拿要挪走的这两段里每一个字面量去对 `src/test`，搬之前就把要跟着改的列出来 ——
   这一次列出来的是 `RoutinePhaseTest`、`InitErrorReplacesDemoContentTest`、`DataVolumeFrontendTest`、`InlineFormResetTest`、`LatestResponseTest` 和上面两个 node 判据。
5. **暴力测试**：两页真浏览器里走一遍（建例行计划、双击「创建」、从任务生成、打卡、删除；统计页来回切日 / 周 / 月）；把浏览器的业务时钟拨过零点看例行计划页会不会重新取。

### 怎么验
真浏览器两页逐个走；全量通过、扰动见红；桌面应用重新打包。

## 结果（2026-10-04）

照计划做完。

- **挪**：例行计划 → `pages/routines.js`（147 行），专注统计 → `pages/statistics.js`（70 行），壳 5434 → 5249 行。代码一个字没改；`state.routineDrafts` 成了模块里的变量。
  `zqShared` 补上 `today`、`latestOnly`、`keepDraft`、`normalizeTask`、`qLabel`、`sLabel`。
- **零点重新取数据**：例行计划模块导出 `dayReload['routines.html']`（只调 `loadRoutines`），壳加载页面模块之后把它接到 `watchBusinessDay` 上；
  壳的 `DAY_RELOAD` 只剩看板。
- **测试直接 import**：`routine-phase-check.js` 改成 import `routinePhase`、`latest-check.js` 改成 import `paintTrend` 并用 `bind` 注入假的 `api` / `$`
  （`freqLabel`、`latestOnly` 还在壳里，照旧从壳里取）。测试那一侧加了两个共用的：`SourceText.frontendScripts()`（壳 + 全部模块，给「全前端都不许 / 至少 N 处」这类判据）、
  `SourceText.functionBody()`（壳里缩进两格、模块里顶格的函数都截得出来 —— 原来每个判据自己找 `"\n  async function "`，函数挪进模块就截不到结尾）。
- **先查判据**：搬之前拿这两段的每个字面量对了一遍 `src/test`，列出来的 7 处（`RoutinePhaseTest`、`InitErrorReplacesDemoContentTest`、`DataVolumeFrontendTest`、
  `InlineFormResetTest`、`LatestResponseTest` 和两个 node 判据）一起改了。`DataVolumeFrontendTest` 的「不许 GET /task/list」顺带改成扫全前端（只扫壳的话，模块里取全部任务看不见）。

**判据**：`PageModulesTest.零点重新取数据`（新：`DAY_RELOAD` 里不许有已经拆走的页面；壳把模块的 `dayReload` 接到 `watchBusinessDay`）；`routine-phase-check.js` 加了
「零点时只重新取列表、不重跑整页启动（不重新接星期按钮、不重新取来源）」—— 用假的 `sh` 真调模块导出的 `dayReload`。扰动 16 个全红。

**扰动这一遍差点骗了我**：第一遍 16 个全红，但新写的 `零点重新取数据` 在**干净的代码上也是红的**（正则 `[^;]*` 跨不过 `return bootDashboard();` 里的分号）——
于是经过 `PageModulesTest` 的 5 个扰动，红可能只是因为这条判据本来就红。修好正则、确认干净时是绿的，再把那 5 个单独重跑一遍，逐条看红的原因都是它该红的那句话。
**跑扰动之前先跑一遍干净的**：一条永远红的判据会让每一个扰动都「被抓住」。

**真浏览器**（`zhiqu_verify`）：专注统计 —— 四个数、14 天的柱子、象限图例；连点「周、月、日、月」最后停在「月」（6 根柱子，乱序回来的不盖掉）。
例行计划 —— 新建一个（双击「创建」只建了一个、标题清空）、星期按钮点亮 / 熄灭、从任务生成一个（勾自动去掉）、打卡、两个都删掉（回到原来的 3 个）；
**过零点**：把页面的 `Date.now` 拨快一天等过一分钟的检查 → 例行计划列表重新取了一次、星期按钮没有被重复接（仍是 7 个）。
（第一次是派发 `visibilitychange` 来演 —— 没反应，查下来是浏览器窗格在后台、`document.hidden` 为真，壳本来就在后台时不查，是演法不对，不是代码。）
加载的是 `pages/statistics.js?v=20261004-routines` 和 `pages/routines.js`。

**验**：全量 959 / 0 / 0 / 0（开着 Docker），这一轮第一遍就是绿的（搬之前先查判据起了作用）；桌面应用重新打包。
