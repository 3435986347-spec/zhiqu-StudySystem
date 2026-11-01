# 第九十二轮（2026-10-31）：`write_file` 拆成两个工具 —— 写整份 / 改一段，命令行和网页 code agent 一起

## 由来
用户 2026-10-31：「去掉核对，接着做下一版尺子，然后接着write_file 拆成两个工具、按缓存命中价记账、命令行和网页版两份 agent 合成一份。」
去掉核对、尺子第二版是第九十一轮；这一轮做第三件。第八十九轮锐评第 2 节：`write_file` 一个工具三种用法（整份 / 追加 / 替换），参数互相打架，
`old_string` + `content` 被当成「换成空」一声不响删代码（评测记录里 19 次，第八十六轮才拒）。拒绝是事后补的；接口本身还允许那种调用。

## 计划
1. 命令行：`write_file` 只管整份写入和追加（`path`、`content` 必填，`append` 可选）；新加 `edit_file` 管改一段（`path`、`old_string`、`new_string` 必填，`replace_all` 可选）。
   给 `write_file` 传 `old_string` / `new_string`、给 `edit_file` 传 `content`：拒绝，说该用哪一个（不猜着做）。
   `LocalTools.prepareWrite` / `prepareEdit` 两个入口，后面的检查（读过、没被别人改过、读全了才能整份写、UTF-8、大小、确认、落盘）还是同一套。
   别家 agent 的 `edit` / `str_replace` 一类名字指向 `edit_file`。
2. 网页 code agent：`write_workspace_file`（`path`、`content`）+ `edit_workspace_file`（`path`、`old_string`、`new_string`、`replace_all`），都只在 `canWrite` 下发；
   同一个文件多次改照样叠在一份草稿上。叙述（`CodeToolNarration`）、提示词跟着改。
3. 提示词、拒绝的说法、`describeEditError` / `TextEdit.describe`、一致性用例的说明、`docs/notes`、命令行 README 跟着改。
4. 判据先红；尺子（第九十一轮的十四题）用用户给的 key 量一遍：拆开以后模型会不会用、有没有掉分。

## 结果
- **命令行**（`local.js`）：`write_file` 只收 `path` + `content`（+ `append`），`edit_file` 只收 `path` + `old_string` + `new_string`（+ `replace_all`），参数各自必填。
  `prepareWrite` / `prepareEdit` 两个入口进同一套检查（`prepareChange`）。给 `write_file` 传 `old_string` / `new_string`（`wrong_tool`）、给 `edit_file` 传 `content`（`with_content`）都拒，说该用哪一个；
  `edit_file` 用在不存在的文件上说「新建用 write_file」，`write_file` 缺 `content` 说清。别家的 `edit` / `str_replace` / `apply_patch` 一类名字指向 `edit_file`。提示词、`describeEditError` 跟着改。
- **网页 code agent**（`CodeWorkspaceAgent`）：`write_workspace_file`（`path`、`content`）+ `edit_workspace_file`（`path`、`old_string`、`new_string`、`replace_all`），都在 `if (canWrite)` 里；
  `TextEdit` 多一种 `WRONG_TOOL`。顺手修了一个老问题：`write_workspace_file` 缺 `content` 原来读成 `""`，整个文件写成空的草稿 —— 现在拒绝。叙述（`CodeToolNarration`）分成「生成草稿 / 修改草稿」。
- 判据：命令行新加 1 条（拆开的两个工具、错的参数、两份 schema），第八十六轮那条按新接口改写；网页新加 1 条（同样的几种错法 + schema + 不能写时不下发）、叙述 1 处、`CodeAgentGateTest` 改成两个写工具都必须在 `canWrite` 那一块里（按括号配对找块尾，不是只比位置）。
  原来测试里 15 处照老写法给 `write_file` 传 `old_string` 的调用全被新的拒绝挡住，改成 `edit_file` / `prepareEdit`；评测工具里钉着的工具清单多了 `edit_file`。
  扰动：命令行 6 处、网页 6 处，全红。门的判据另有一个只有它照得出的样本：把 `edit_workspace_file` 挪进 `if (canWrite || canExec)`（只读时照样不下发、行为判据绿着），门红。
- **尺子**（十四题 × 2 遍，第九十一轮的模型 ID 23）：**25/28**。没过的是 deep-merge 两遍（这题历来 0/3–2/3）、user-cache 一遍（第九十一轮 3/3，单题波动内）。
  模型调了 `edit_file` 26 次、`write_file` 10 次（新建测试文件这类），**给错工具 0 次**。第二版四题平均输入 24.6K token / 遍（第九十一轮 28.4K），差不多。花费保守口径（全按未命中价）约 ¥5.6。
  尺子的每一遍多记了各工具调了几次（`calls`）和给错工具被拒几次（`wrongTool`）；第八十九轮的「核对」计数去掉。
- **真浏览器**（用户 2026-11-01 新给的 key，只在验证库：管理员测试账号 `r92web_6913da`、模型 ID 25；一个 WRITE、指向临时目录的后端）：
  在 AI 助手的代码模式里让真模型「修 add、末尾加 sub」「给测试加一条 sub 的断言」—— 两次都是先读、再 `edit_workspace_file`（流里是「读取 → 修改草稿（替换一段）」），
  diff 对、确认后落盘、测试跑过。点出来一个**真错**：代码草稿的确认框只自动弹一次，关掉（点到遮罩、按 ×）以后产物卡片上没有按钮 —— 卡片的「能确认的类型」清单里漏了 `CODE_DRAFT`，不刷新页面就没处确认。
  修了：按钮抽成 `artifactActionsHtml`，清单加上代码草稿；`artifact-actions-check.js` 在 node 里真跑它（去掉 `CODE_DRAFT` 就红）。浏览器里关掉确认框 →「查看并确认」→ 重新打开 → 确认写入，走通。缓存令牌 `20261102-r92a`。
- **一个坑**：第一次起那个后端时只给了命令行的 `app.workspace.mode` / `root`，实际生效的却是 `~/.zhiqu/workspace-state.json` 里用户选的 EXEC + 一个真实项目目录 ——
  code agent 在那里列了目录、搜了一遍「calc.py」（没写，草稿也没出；文件名发给了模型）。之后的后端都带 `--app.workspace.state-file=<临时路径>`，写进了 `docs/notes/code-workspace.md`。用户那份文件没被改过。
- 三组判据：后端全量 1331（0 失败、0 跳过）、命令行 270/270、评测工具 95 过 1 跳。
