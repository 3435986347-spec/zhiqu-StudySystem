# 第三十三轮（2026-10-04）：参考计划拆成模块（方案第 4 步的第四块）

## 由来
方案第 4 步接着一页一页搬。参考计划页（`shared-plans.html`）自成一块：列表、我的投稿（驳回原因）、分享我的计划、详情与套用。
分类表（`PLAN_CATEGORIES`）后台也用，留在壳里经 `zqShared` 给。

## 计划（开工时）

1. **挪**：`bootSharedPlans` … `openPlan`（含 `SUBMISSION_STATUS`、`loadMySubmissions`、`loadPlans`、`submitPlanTemplate`）进 `pages/shared-plans.js`，代码一个字不改。
   `zqShared` 补上 `writeKey`（套用时「一次打开 = 一次套用」的那个键）。
2. **先查判据**（第三十二轮起的做法）：拿这一段的字面量对 `src/test` —— 列出来的是 `TaskFormTest`（个数那一句）、`InitErrorReplacesDemoContentTest`（详情弹窗的关闭）、
   `SharedPlanApplyOnceTest`（套用只执行一次）、`RequestResilienceTest`（自己带幂等键的只有两处）。
   **查的时候还照出一个前几轮留下的空子**：`RequestResilienceTest` 的「写操作不绕过 request()」「自己带键的只有两处」只扫壳、`zhiqu-ui.js` 和页面 ——
   第三十轮起拆出去的模块都不在里面，模块里直接 `fetch` 一个 POST、或者在点击里现生成键，这两条照样绿。改成扫 `assets/` 下全部脚本。
3. **暴力测试**：真浏览器里筛选 / 排序来回切、打开详情、连点「套用」（只套用一次）、点赞、分享我的计划（不勾隐私确认被拦）。

### 怎么验
真浏览器走一遍；全量通过、扰动见红；桌面应用重新打包。

## 结果（2026-10-04）

照计划做完。

- **挪**：参考计划页进 `pages/shared-plans.js`（191 行），壳 5249 → 5070 行，代码一个字没改；`zqShared` 补上 `writeKey`。
- **前几轮留下的空子**：`RequestResilienceTest` 的两条（「写操作不绕过 request()」「自己带幂等键的只有两处」）改成扫 `assets/` 下全部脚本 + 页面。
  这次挪的正好是两处之一（套用参考计划），不改的话它会直接报「少了一处」—— 但更要紧的是反方向：第三十到三十二轮拆出去的模块里，
  直接 `fetch` 一个 POST、或者在点击里现生成一个键，这两条一直是绿的。扰动 S6 / S7 现在都红了。比较时按文件名排序再比（扫的是目录，先后跟着目录结构走）。
- 跟着改的判据：`TaskFormTest`（个数那一句，用 `SourceText.functionBody`）、`InitErrorReplacesDemoContentTest`（详情弹窗的关闭）、`SharedPlanApplyOnceTest`（键在打开时生成）。

**真浏览器**（`zhiqu_verify`）：分类下拉是那七个办公分类、来回切分类和排序、打开详情；**连点套用**（日期框里的「套用」点两下、回来之后再点一次「套用」）→
任务从 17 个变成 19 个（这个计划正好两条任务，只套用了一次）；点赞 ♡0 → ♥1 → ♡0；「分享我的计划」列出 22 条可选、7 个分类，不勾隐私确认点提交 → 弹窗不关、什么都没提交。
加载的是 `pages/shared-plans.js?v=20261004-plans`。套用出来的两条任务留在 `zhiqu_verify` 里由用户删。

**判据**：扰动 8 个全红（模块表少一项、`zqShared` 少给 `writeKey`、点击里现生成键、个数那一句写成 `if (false)`、详情弹窗关不上、模块里直接 `fetch` 写操作、
模块里另带一个键、列表不问 `current()`）。

**验**：全量 959 / 0 / 0 / 0（开着 Docker），第一遍就是绿的；桌面应用重新打包。
