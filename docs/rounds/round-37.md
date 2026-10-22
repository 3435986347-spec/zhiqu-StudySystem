# 第三十七轮（2026-10-05）：AI 助手拆成模块（方案第 4 步的最后一块）

## 由来
方案第 4 步的最后一页：AI 助手（`ai-assistant.html`）—— 壳里最大的一段（约 2200 行：Notebook 与资料、聊天与流式、执行轨迹、计划草稿确认、
代码工作区面板）。搬完之后壳只剩共用层（请求、业务时钟、草稿、弹窗、提示、登录与共享登录、页面里的提醒、番茄钟待补记、任务表单、Markdown 渲染、
设置弹窗的路由、页面模块的加载）。

## 计划（开工时）

1. **先把夹在里面的共用件挪出来**（壳里挪位置，行为不变）：AI 那一段中间夹着 6 个别处也用的 —— `pickFile`（设置弹窗换头像）、`popMenu`（Wiki）、
   提醒渠道的规矩（`REMINDER_FIELDS` / `currentReminderChannel` / `reminderChannelReady`，设置弹窗和任务表单）、`revealContent`（`route()`）。挪之前用脚本数过：
   AI 那一段里定义的东西，段外只用到这 7 个名字。
2. **挪**：剩下的整段进 `pages/ai-assistant.js`，代码一个字不改；绑定清单由脚本从这段代码里数出来（段外定义、段内用到的）。
3. **四个从壳里抠函数的 node 判据**（`request-check.js` 里聊天流那几段、`msg-failure-check.js`、`step-note-check.js`、`diff-check.js`）：能 import 的改成 import
   （模块导出被测的纯函数 + `bind`，测试注入假的 `sh`）；要换掉模块内部调用的，照第三十六轮的做法从模块文件里抠。
4. **先查判据**：字面量对一遍 `src/test`，**再看一遍对壳跑正则的判据**（第三十六轮漏过一条）。特别留意 `assertFalse` 一类 —— 代码一搬走它们自动变绿。
5. **暴力测试**：真浏览器里新建 Notebook、上传资料、发消息（假模型流式）、发送中刷新（从库里接回）、断网发送、计划草稿确认弹窗、示例问题、`?ask=`、工作区面板（管理员）。

### 怎么验
真浏览器走一遍；全量通过、扰动见红；桌面应用重新打包。

## 结果（2026-10-05）

照计划做完。**方案第 4 步到此做完**：壳 `zhiqu-api.js` 从第三十轮开始时的 6007 行降到 1832 行，只剩共用层；每一页都是 `assets/pages/` 下的一个模块
（AI 助手 2162 行、知识 Wiki 954、后台 290、参考计划 191、例行计划 147、看板 114、任务 77、专注统计 70），设置 / 成就弹窗是 `assets/settings.js`（605）。

- **先挪出来的共用件**：`pickFile`、`popMenu`、提醒渠道的规矩（三个）、`revealContent` 从 AI 那一段中间挪到它前面（壳里换位置，一个字没改）。挪完再数：AI 那一段里定义的，段外只剩 `bootAiAssistant` 一个名字。
- **挪**：AI 助手进 `pages/ai-assistant.js`。绑定清单由脚本数出来（26 个壳里的名字 + `$` / `$all`），`zqShared` 补上 `REQUEST_TIMEOUT_MS`、`role`、`requestError`、
  `redirectToLogin`、`nowMs`、`serverTime`、`highlightCode`。壳里的 `boots` 表没有了，`route()` 只认 `PAGE_MODULES`。
- **唯一改动的地方**：原来壳顶层有一个每秒一次的定时器（「已等 N 秒」的计数，每一页都在跑），挪进模块后 import 时就会开 —— 改成启动这一页时开一次（`startWaitTicker`）。
  `PageModulesTest.模块顶层只有声明` 钉住「模块被 import 时不做事」。
- **四个 node 判据**：`step-note-check.js`、`diff-check.js` 改成 import（模块导出 `stepNoteHtml`、`diffLines`、`diffHtml`，测试 bind 一个只带真 `esc` 的 sh）；
  `request-check.js`（聊天流那几段）、`msg-failure-check.js` 要在同一个作用域里换掉内部的东西，改成从模块文件里抠。
- **跟着改的判据**（这一轮先跑了一遍不带 Docker 的全量看谁红，17 条，全是读壳的）：`AiReadTasksWiringTest`、`ChatBubbleSpacingTest`、`CodeModeToggleWiringTest`、`DraftsTest`、
  `MainFlowWalkthroughTest`、`MessageFailureRenderingTest`、`StepNoteRenderingTest`、`WorkspaceControllerGuardTest`、`UserMessageFitTest`、`RequestResilienceTest`（读模块）；
  `ContextOptionKeysCoverageTest` 的「活壳」改成全前端（只读壳的话「有意未接线的键不许有人发」会悄悄变绿）；`InitErrorReplacesDemoContentTest`、`PageNotifyAndSharedLoginTest`、
  `PomodoroOutboxTest` 的锚点换成 `await pageModule.boots[page](zqShared);`；`PageModulesTest.每个页面都有人启动` 改成「壳里没有 boots 表、每一页都在 PAGE_MODULES 里」。
- **「不许出现」类判据的审计**：把所有读壳的 `assertFalse` 过了一遍，只有一条会因为搬家悄悄失效 —— 「代码里不许有『后续版本提供』这类占位话」（第三十六轮起只读 Wiki 模块），改成扫全前端。
  同一处 `patchSetCard` 那条用的是本地按 `"\n  }\n"` 截函数体的写法，在模块代码上会截过头，换成 `SourceText.functionBody`。

**扰动**：13 个，第一遍 2 个是绿的，都照出了判据的问题：
- W4（模块 import 时就开定时器）—— node 判据 import 模块之后不到一秒就跑完退出，定时器还没来得及触发；于是加了 `模块顶层只有声明`，按源码钉。
- W6（`?ask=` 在载入消息之前填）—— `bootAiAssistant` 里还有一处 `await loadAiMessages()`（新建 Notebook 的按钮里），删掉启动时那一行判据照样找得到。
  **这个弱点搬家之前就在**；改成认函数自己那一行（两格缩进、单独一行）。
改完 13 个全红，逐条看过红的原因。

**真浏览器**（`zhiqu_verify`，脚本化的慢假模型：一句话 6 秒说完、说「制定」就回一个计划工具调用）：AI 助手从模块启动、原来的对话照常显示（表格）；
发一句 → 一段一段流出来（0.7 秒取一次：39 → 103 → 151 → 215 → 263 → 327 字）、输入框清空；**发出去马上刷新** → 回来之后那条回答完整、说完了；
「帮我制定下周的工作计划」→ 计划草稿确认弹窗（两条任务、忽略 / 修改 / 确认写入）→「修改」进编辑（6 个输入框）→「忽略」关掉、任务数没变；
`?ask=帮我排一下今天` → 输入框填好、聚焦、地址里的参数去掉；**断网发送**（把后端停掉再点发送）→ 消息数没变、字放回输入框、提示「网络连接失败，这句没发出去 —— 字放回输入框了，连上网再发」；
临时提成管理员 → 工作区面板「代码工作区 · 未启用」、「代码」按钮不出现（工作区没开）。加载的是 `pages/ai-assistant.js?v=20261005-ai`，控制台只有那一条断网发送的报错。
这一轮发的几句话和那段对话留在 `zhiqu_verify` 里由用户删。
**没在浏览器里走的**：计划里写的新建 Notebook、上传资料没走（这一轮没动那几段的逻辑，「上传时没有 Notebook 就替用户建一个」由 `MainFlowWalkthroughTest` 管着）。
「发出去马上刷新」那一下，刷新回来第一眼那条回答已经是完整的 —— 分不出是「从库里接回」那条路补上的还是流本来就跑完了（6 秒的回答，刷新本身花了 2 秒多）；
接回这条路由 `request-check.js` 的「断线接回」几条和集成测试管。

**第一遍全量红了 1 条**：`NetworkCompressionIntegrationTest.文字类回包是压过的` 要求壳 `zhiqu-api.js` 压完不到原文的三分之一 —— 壳从 338KB 拆到 115KB、
剩下的大半是中文，压完是 2.8 倍。压缩本身没问题，是那个 3 倍是照着原来那个大文件定的；而且页面脚本的大头现在在模块里，那条判据一个模块都没看。
改成：壳、`settings.js`、`zhiqu-ui.js` 和 `assets/pages/` 下的每一个都要按 gzip 发、解开和原文一样，总数压到一半以下（现在 2.9 倍；没压是 1 倍），扫到的脚本不少于 10 个。
扰动两个都红：压缩类型里去掉脚本（「settings.js 没压」）、扫空（「扫到 0 个」）。

**验**：全量 960 / 0 / 0 / 0（开着 Docker；第一遍红的那 1 条改完之后）；桌面应用重新打包。
