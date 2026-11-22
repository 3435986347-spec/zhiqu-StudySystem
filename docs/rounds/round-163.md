# 第一百六十三轮（2026-11-22）：coding agent 用户决策第 4 步——Windows 本机桥源码

接续第一百六十二轮 macOS 本机桥。本轮在 **macOS 环境** 修改 Windows 外壳；用户明确说 Windows 真机当前不可用，因此不宣称 C#、WebView2 或 Windows 本机进程已验证。

## 现状与边界

- 页面和 JS 宿主已经与平台无关：新版本机 run 带 `userDecision: true`，`waitLocal` 复用同一个多问题面板。
- Windows `LocalAgent` 收到 `question` 仍会按未知消息 fatal，`LocalBridge` 没有 `answer`，`question` / `question_resolved` 也不进快照。
- 本机没有 `dotnet` / `csc` / `mcs`，不能编译 C#；不能运行 WinForms、WebView2、cmd、Windows Job Object 或 Windows 打包 exe。

## 计划

- **源码对齐 macOS 协议**：`LocalRunRequest` 只认布尔 `userDecision: true`；`LocalAgent` 登记 `question`，新增 `answer` 校验和 `question_result`，只接受当前运行、已登记批次。
- **答案规则**：全部问题必答、方案编号必须存在、其他输入非空且最多 2000 字；规范化后的相同答案幂等，冲突不覆盖，结果到达 / 停止 / 退出后拒收。
- **快照**：`LocalBridge` 新增 `answer` 动作，`question` 与 `question_resolved` 进 `resume` 事件；沿用页面现有面板，不改权限、草稿、命令和通知桥。
- **真实 Windows 判据只写不跑**：扩展现有 `deploy/desktop/windows-checks` 的真实 Node / 假网关场景，覆盖两题、非推荐项、其他输入、重复与冲突提交、停止后迟到答案；WebView2 场景保持真实验收用途。
- **Mac 可执行验证**：运行共享前端脚本、CLI 全量和后端全量；`WindowsDesktopShellTest` 跳过要如实列出，静态文本扫描不能算 Windows 通过。
- **交付边界**：不再次调用付费模型，不部署、不发布 npm、不提交 Git、不制作或上传 Windows 安装包。页面没有改动，不换缓存令牌。

## Windows 真机待验收

1. 用 `deploy/desktop/package-windows-native.ps1` 重新打包带本轮 C# 与 CLI 的 exe，不能用第 158 轮旧包代替。
2. 执行 `WindowsDesktopShellTest`，必须看到真实编译、Node、WebView2 和进程测试实际运行，Skipped 不算通过。
3. 在真实 WebView2 输入框上方完成两题、非推荐项、其他输入、切题、连点、离页恢复和待答停止；确认模型收到实际答案。
4. 核对旧页面 / 旧外壳的文字提问退路，以及新包内 Node 释放和完整 `question` → `answer` → `question_result` 链路。
5. 分别扰动能力开关、重复提交防护和已答快照，确认新增 Windows 判据见红后恢复；本轮在 Mac 上没有让这些场景见过红，不能把它们计作已生效判据。

## 实现

- `LocalRunRequest` 只接受布尔 `userDecision: true`，`Payload` 原样交给共用宿主；缺省与字符串都为 false。
- `LocalAgent` 按编号登记 1–4 题，`Answer` 复核全部答案、方案与其他输入。答案先规范化再比较；相同答案 duplicate、不再次写给宿主，冲突不覆盖。`_gotResult`、`_stopping`、进程退出或输入关闭后拒收。
- `LocalBridge` 新增 `answer`：只认当前运行与待答快照；`question` / `question_resolved` 进 `resume`。UI 线程内立即落已答事件再回复，后台宿主事件仍经原同步上下文投递。
- `windows-checks/Program.cs` 新增真实 Node + 假网关决策场景：两题、非推荐项、其他输入、漏答、规范化重复、冲突、迟到和待答停止；`WebChecks.cs` 新增真实桥与快照场景。
- 页面未改动，继续复用第一百六十一、一百六十二轮面板；缓存令牌保持 `20261122-r162`，没有新增库、数据库表或安装包。

## macOS 上已执行

- 本机没有 `dotnet` / `csc` / `mcs`：未编译 C#，未运行 WinForms、WebView2、cmd、Job Object 或 Windows exe。
- `WindowsDesktopShellTest` 定向运行显示 **Tests run: 0**（平台假设在 `@BeforeAll` 阻止执行）；这不是通过，也不是 Windows 判据的 5 个 Skipped 计数。
- `WebChecks.cs` 内嵌验收 JavaScript 通过真实 `vm.Script` 语法检查；只证明 JS 语法，不证明 C# 或 WebView2 行为。
- `decision-check.js` 与 `stream-reattach-check.js` 均 ALL-GREEN。
- CLI 全量 700 项：678 通过、22 跳过、0 失败；其中 Windows 专属 3 项明确 SKIP。
- 后端 `mvn -o clean test` 全量 1561 项：1561 通过、0 失败、0 错误、0 跳过，BUILD SUCCESS。Windows 平台在 `@BeforeAll` 拦截，未产生测试项计数，不能从这个总数推断 Windows 已验。
- 未部署、未发布 npm、未提交 Git、未制作或上传 Windows 安装包。第 163 轮到这里只完成源码与 Mac 可执行回归；Windows 新增场景尚未执行、尚未见红，必须完成上面的真机验收，不能宣称 Windows 功能已通过。
