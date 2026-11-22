# 第一百六十一轮（2026-11-22）：coding agent 用户决策第 2 步——宿主、网页后端与弹窗

接续第一百六十轮的 `ask_user` 内核，本轮打通网页代码模式。macOS / Windows 本机外壳在后续轮次接入。

## 计划

- 宿主协议新增 `question` / `question_result`，只有客户端声明 `user_decision_v1` 能力时才给宿主下回答复能力；旧客户端不下发工具。
- 后端按运行保存待答批次，校验问题、归属、完整答案和其他输入；相同答案重复提交不重复唤醒，冲突提交第一次有效。
- SSE 增加 `decision.ask` / `decision.resolved`，先记录解决事件再唤醒宿主；刷新 / 重连回放待答问题，运行结束取消待答等待。
- 网页在输入框上方实现多问题卡片：左右切换、方案与推荐标记、其他输入、全部回答后提交；连点、切页和异常不能造成重复回答。
- 问题与选择进入 `decision` 步骤；不新增数据库表，不改变普通聊天和既有权限确认。
- 新判据先见红或经定点扰动见红，完成真 Node、后端、前端行为、真浏览器及缓存令牌验证。

## 实现

- `code-host.js`：只有 `run.userDecision === true` 才设置 `ctx.decide`。桥新增 `question` / `question_result`，迟到回音按 retired 丢弃；等待答案时 stop / abort 立即收尾，不永久等待。
- `DecisionPort`：一轮一份，注册时复核 1–4 题、编号、2–6 个选项、推荐项和其他输入；答案必须完整且只能选已登记方案。状态为待答 / 已答 / 取消，第一次提交有效；相同答案返回 duplicate，不重复唤醒，冲突不覆盖。
- `ChatRunHub`：新增 `decision.ask` / `decision.resolved` 回放，先落解决事件再唤醒宿主；运行 finish / abort 取消待答，迟到答案拒绝。`AiRunController` 新增答案接口并先查运行归属，不新增数据库表。
- `CodeWorkspaceAgent` / `JsCodeAgent`：只有 `contextOptions.userDecision` 为字面 true 才向宿主开启能力；新重载保留旧调用兼容，普通聊天和无能力客户端不下发 `ask_user`。
- 页面：发送时声明 `userDecision: true`。`#zq-decision` 位于项目栏和输入框之间，左右按钮 / 键盘切题，方案说明与推荐标记、其他输入、完整后提交；各题答案独立保存，提交中防连点，失败可重试，实时 SSE 和重连回放共用 `makeStreamApplier`。
- `TraceSteps` 认 `decision` 步骤。所有模型文字转义，样式只在 `.zq-decision*`，手机限制面板高度，无横向溢出。
- 静态缓存令牌统一为 `20261122-r161`；AI 助手首页轮播浅 / 深图换成真实提问面板（2048×1280，完整页面等比缩放、两侧补背景色）。
- 判据：`host-decision.test.js`、`DecisionPortTest`、`JsCodeAgentDecisionTest`、`ChatRunHubTest`、`decision-check.js` / `AiDecisionTest`；旧流式切片桩补空的 `#zq-decision`，`WikiWriterStateTest` 的 mock 更新到新重载。

## 验证

- 基线专项 31 项全绿；宿主新判据旧实现首次 4 项中 3 项失败。后端 21 项、前端与重连 22 项随后全绿。
- 后端测试先照出「运行关闭后迟到取消仍被接受」，已在 `DecisionPort` 入口按 closed 拒绝并复测通过。测试手拼 JSON 的夹具问题改用 Jackson 生成，未当成产品见红。
- 五处定点扰动均见红并恢复：禁用宿主能力（3 项失败）、绕过重复提交防护（1 项失败）、解决事件与唤醒顺序颠倒（1 项失败）、答案永远算完整（断言失败）、去掉提交中防连点（重复请求 2 次）。
- 真 Spring 后端 + 真 Node 宿主 + 本机假模型 + WKWebView：两次完整问答。第一次选非推荐方案并填其他输入、连点提交；第二次待答时刷新再提交。两次模型均收到决定，375px 横向溢出 0。浅 / 深两套各走一遍并截图检查。
- 命令行全量 700 项：678 通过、22 跳过、0 失败。
- 后端全量 1561 项：1561 通过、0 失败、0 错误、0 跳过（`mvn -o clean test`，BUILD SUCCESS）。
- 未部署线上、未发布 npm、未提交 Git；macOS / Windows 本机决策桥留到后续轮次。
