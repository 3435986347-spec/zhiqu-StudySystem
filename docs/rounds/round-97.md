# 第九十七轮（2026-11-02）：两份 coding agent 合成一份 —— 第 3 步（下）：删掉 Java 的循环

## 由来
第九十四轮定的三步的最后一块（第九十六轮把第 3 步拆成两轮：先打包、再删）。第九十六轮之后 js 那份在开发、桌面应用、网页服务器上都起得来
（找不到 zhiqu-cli 目录时用 JAR 里带的，桌面应用带 node），「起不来就退回 Java 的循环」这条后路可以拿掉了。

## 计划
1. `CodeWorkspaceAgent` 只留门和桥：`readableBy`、`run`（门判完交给 `JsCodeAgent`）、`recentHistory`、`remoteTools`（Wiki / 里程碑经桥执行，同一个循环状态）、
   `recordMilestonePlan`、`refusal`、`offeredToolNames`、`Result` / `LoopState`。删掉 Java 的工具循环、`buildTools`、`executeWorkspaceTool`、读文件分段、系统提示、编码温度。
   js 起不来（找不到 node）时不再退回：轨迹里说清「代码模式要 Node」，结果是空的（主回答照常）。
2. 跟着没人用的删掉：`TextEdit`（Java，替换一段的那份；一致性用例 `conformance/text-edit.json` 留给命令行那份用）、`CodeToolNarration`（Java 循环的叙述，js 那份用命令行的说法）。
   开关 `app.ai.code-agent.engine` 去掉（application.yml、生产模板、测试配置）；`node`、`cli-dir` 留着。
3. 判据：Java 循环的那些（`CodeWorkspaceAgentTest` 里测循环本身的、`CodeToolNarrationTest`、`TextEditConformanceTest`、`CodeWorkspaceWikiReceiptTest`、
   `CodeAgentGateTest` 里对 `buildTools` 的源码断言）—— 同样的性质在命令行那份已经有判据的删掉，门上的改成断言「门的结果原样交给 js 那份」；
   `CodeAgentLoopIntegrationTest`（真库、真主流程）改成真起 node 跑 js 那份。删之前拿每条判据的名字对一遍，列出哪条性质由哪条新判据接着管。
4. 判据先红；三组全绿；真浏览器里默认配置走一遍代码模式。

## 结果
- `CodeWorkspaceAgent` 800 → 308 行：只剩门（管理员、档位、写意图、能不能执行、项目引导）和桥（`remoteTools`：Wiki / 里程碑经桥执行，同一个循环状态）。
  js 那份起不来（找不到 node）时不再退回：轨迹里说「代码模式要用 Node（≥ 18.17）」，结果是空的，主回答照常。
- 删了：Java 的工具循环、`buildTools` / `executeWorkspaceTool` / 分段读 / 系统提示 / 编码温度；`TextEdit.java`（用例表 `conformance/text-edit.json` 留给命令行那份）、
  `CodeToolNarration`（网页轨迹的说法第九十四轮起就是命令行的 `describeCall`）；开关 `app.ai.code-agent.engine`（application.yml、生产模板、测试配置）。
- 判据的去向（删之前一条条对过）：
  - `CodeWorkspaceAgentTest` 23 → 6 条：留门（不是管理员 / 工作区关着连起都不起）、新的「门的结果原样交过去」（只读档 / 没写意图不给写、执行器不能跑不给跑）、
    交给命令行那份（里程碑交回主流程、起不来说清楚）、远程工具清单、历史截取、Wiki 工具名一份。测 Java 循环本身的 17 条删了 —— 同样的性质在命令行那份：
    工具下发清单（code-host.test.js）、没读过不许改 / 读过之后被改过（local-tools、code-host 草稿层）、改一段的几种错法（local-tools 第八十六 / 九十二轮、edit-conformance）、
    分段读与截断（local-tools、odd-files、agent.test.js）、温度（HarnessModelGatewayTest）。
  - `CodeAgentGateTest`：对 `buildTools` 的三条源码断言删了（同上），「没有写意图时不得下发写工具」改成断言 canWrite 原样交给 js 那份。
  - `CodeToolNarrationTest`、`TextEditConformanceTest`、`CodeWorkspaceWikiReceiptTest` 删了：叙述在 `wiki-search-label.test.js`；Wiki 待合入草稿的编号只从后端 `WikiToolAgent` 的回执来
    （js 那份交回的结果里根本没有这个字段），「模型说了也不算」由结构保证。
  - **`CodeAgentLoopIntegrationTest`（真库、真主流程）改成真起 node 跑 js 那份**：假模型照网关的流式请求回工具调用增量，读 → 跑判题 → 记薄弱点 → 写草稿，库里的痕迹和磁盘不动都照旧断言。
- 扰动 4 处（起不来不说、门不判写、不是管理员也起、判过题也不给记薄弱点），全红。
- 真浏览器（默认配置、用户的 key）：「把 two_sum.py 实现成哈希表解法，写成草稿」—— 读两个文件、一次 edit_file，确认框里 diff 对。
- **两份 coding agent 合成一份到这里做完**：命令行、网页、桌面应用跑的是同一份循环、同一套工具和规矩。
- 三组判据：后端全量 1290（0 失败、0 跳过；比上一轮少 57 条 —— 删掉的 Java 循环判据，去向见上）、命令行 282/282、评测工具 99 过 1 跳。
