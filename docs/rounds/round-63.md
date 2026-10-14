# 第六十三轮（2026-10-14）：AI计划与知识Wiki真实状态闭环

## 用户反馈

1. AI助手文字显示已生成计划后，真正可确认的计划草稿还要等几秒。
2. 知识Wiki上传来源提示解析完成，但页面里看不到来源。
3. AI助手声称更新index和log，却没有待合入变更；用户截图显示追问后助手承认只把正文写在对话里。

## 计划

- 顺着真实SSE / PLAN_DRAFT链检查后处理延迟，已有结构化草稿直接复用，草稿事件到达立即可确认；没有真实草稿前如实显示正在整理。
- 串通来源上传 / 解析 / 来源列表与预览 / 从来源生成待确认变更，保留用户确认后才合入；用户数据按owner隔离。
- 知识写意图和实际工具提交闭环，捕获真实PatchSet结果；最终回答根据本轮真实状态提示，index/log只在确认后由系统维护。
- 先复现断言失败再修复，明确Failures和环境Errors；验证发布的JS模块并使用本机内存fakeAPI做真浏览器验证。
- 所有前端修改收口后统一更新HTML与service-worker缓存令牌。公共接口改动后JDK17全量clean检查。

公司电脑不下载 / 运行Docker，不启动用户桌面应用，不调用真实模型或修改真实Wiki / 任务数据。
仓库评测方案先独立推送，本轮修复另存提交和验证记录。

## 实现结果

- 计划仍需在回答后整理为结构化草稿，这段时间显示 `message.processing`。已存在的结构化计划直接复用；PLAN/TASK/ROUTINE 草稿 SSE 带完整确认字段，不再等 done 和额外 GET。自动确认框排队显示，切换 Notebook、新回合和失效草稿不会留下旧队列。
- Wiki 新增来源记录分页与本人来源详情接口；上传、粘贴导入成功立即预览保存的正文。来源仍独立保存，点「生成待合入变更」后进入审核面板，用户确认才合入。导入 busy、来源视图单实例/latest 请求标记以及按来源共享的生成请求避免连点和乱序覆盖。
- 识别「生成/创建 Wiki」写请求，纯状态查询、否定请求仍只读，复合写请求不被前半句的问题误挡。OpenAI/Anthropic 工具循环在只输出文本时最多提醒一次；成功只认服务端真实正整数编号与 PENDING 状态。
- 最终回答将真实执行状态与不可信 Wiki 正文分开传递。无回执时说明结果未确认，不能声称已保存；已跑写工具但无真实草稿时不再把失败说明包装为 Wiki 正文。没有工具能力的模型保留普通 Wiki 草稿兜底，并在生成前如实说明还未保存。index/log 仍由系统在用户合入后维护。
- 代码判题循环也可能创建 Wiki 草稿：`CodeWorkspaceAgent.Result` 增加 immutable 的可信编号列表，保留四参构造兼容；编号来自同一 Wiki 执行器的服务回执。最终 writer、curator 及 trace 合并两路状态，正文截断也不会丢失真实编号。
- 全站 HTML 与 service-worker 缓存令牌更新为 `20261014-wiki-plan`。

## 真浏览器检查

CUA 加载发布静态页，后端为本机内存 fake API；没有桌面应用或真实数据库参与。

- 文件上传后即显示保存的原文，来源记录可再次打开；浏览器控制台无 error/warn。
- 同一新测试服务中连点粘贴导入，实测仅 1 次来源 POST、1 个预览弹窗；来源数由 1 到 2，而知识页仍 1、草稿仍 0。
- 点击生成后仅 1 次 patch-set POST；面板显示 1 组 PENDING，知识页仍 1，未调用 apply。
- 假 SSE 故意在完整草稿到达 8 秒后才 done。真实页面在 done 前展示唯一计划确认框，发送按钮仍显示生成中；草稿出现之前显示「正在整理可确认的计划草稿」。
- 确认前内存写入计数为 0；编辑任务名后明确确认，计数变为 1，回执保留编辑后的标题。
- 截图：`/private/tmp/zhiqu-round63-proof/plan-confirm.jpg` 与 `wiki-source.jpg`（临时验证产物，不含真实用户资料）。
- 首页 Wiki 宣传截图使用 `seed-demo.js` 的公开示例正文、内存账号「林舟」重出浅/深两套，2048×1280 WebP；新「来源记录」入口可见。使用后台 CUA 浏览器，无需原生 Snapshot 窗口，未启动用户桌面应用；截图后恢复浏览器尺寸。

## 验证记录

- 计划原实现后端 4 个实际 Failures / 0 Errors，发布 JS 原实现 6 个 Assertion Failures；新增队列与取消判据均经过独立源码扰动见红，最后 19 个 Node 行为案例通过。
- 来源详情原实现 2 个实际 Failures / 0 Errors；发布 JS 原实现 6 个 Assertion Failures，竞态追加 4 个修前断言失败，最后 10 个 Node 行为案例通过。
- Wiki 原实现 6 个实际 Failures / 0 Errors；缺状态提示、两协议各一次提醒、只读状态门的独立控制均有真实 Assertion Failures。复合请求追加判据先 3 个断言失败，修复后通过。
- 实际最终 writer/curator 接线原实现 4 个 Failures / 0 Errors，接线后 4 项通过；缺回执结果不确定的措辞追加判据先 1 个 Failure / 0 Errors，再修复。
- 代码循环 typed 回执丢失判据先真实 Failure / 0 Errors；4 项 fake-loop 验证服务回执、正文截断、伪造编号与未授权写隔离，旧代码执行回归加 Wiki 执行组共 37 项通过。跨 runner/writer/curator 合并追加 3 个断言先真实红（3 Failures / 0 Errors），再接线。
- 首次全量在沙箱被 Swift 缓存权限及 DesktopLauncherTest 的测试 JVM 崩溃中断，不计通过；随后 JDK17、ByteBuddy 预加载、临时 clang 缓存、显式跳过 Docker 的 clean 全量跑到 1094 条 / 3 Failures / 0 Errors / 235 Skipped：2 项与第五十九轮相同的 Node 基线失败，另 1 项是尚未补齐的 round-63 文档索引。索引已补齐；后续 typed Wiki 回执收口后再 clean 验证。
- 最终源码冻结后重新 `mvn -o clean test -Dzhiqu.skipDockerTests=true`（JDK17、bundled Node 路径、ByteBuddy javaagent、临时 clang 缓存）：**1101 Tests / 2 Failures / 0 Errors / 235 Skipped**。本轮 8 个新增测试类共 **37 / 0 / 0 / 0**，两份发布 JS 行为模块分别 **19 / 19、10 / 10**。缓存、文档、源码洁净、权限、Wiki/代码旧回归均通过。
  仅剩第五十九轮已记录的 `HarnessCliNodeSuiteTest.全部通过`（Node 输出缺少 TAP，底下还有既有斜杠菜单失败）和 `NodeRunnerTest.被取消的测试要点名`（缺少 TAP）。这次全量不能写成全绿；Docker/真实数据库集成未执行。
- 两次独立只读审查发现的计划双弹窗、来源竞态、跨 agent Wiki 回执丢失均已修复并复审；收口后无剩余 P1/P2。`git diff --check` 通过。

本轮真实模型请求 **0**，费用 **¥0**；所有写入证明只发生在内存 fixture 中。未下载安装 Docker，未启动或重启用户桌面应用。源码和静态资源需重新打包/更新应用后才会在已运行的旧 JAR 中生效。
