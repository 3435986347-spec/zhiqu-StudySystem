# 第十轮（2026-09-28）：网页 code agent 一次做对、写完即查语法、桌面启动快一半

## 计划（开工时）
方向延续第九轮（复杂任务、长输入、一次做对、性能）。

- W1 网页 code agent 读文件按窗口分段（offset / limit），只读一部分不许整份重写
- W2 网页 code agent 写支持按原文替换（old_string / new_string / replace_all、CRLF、没找到给线索）——
  与命令行共用一份 conformance 用例，两边规矩不许分叉
- W3 网页 code agent 工具循环的对话预算（原来无上限：几个大文件就超窗口 → 「工具循环中断」）
- C1 命令行写完 .json / .js 立即查语法，结果里说出来
- P1 桌面启动：先量（胖 JAR vs 解压 vs 解压 + CDS），值得才做

## 过程中查实 / 改主意的地方
- `node --check` 原地查带 export 的 .js：连真的语法错误也放行（退出码 0）→ 按内容定类型、拷到临时目录用 .mjs / .cjs 查。
- 工具循环预算第一版「最近 4 条原样」：一次读能给到预算的一半，4 条原样本身就超预算 → 改成从最旧的开始省略、只保最新一条。
- 启动：基础 CDS 单独几乎不提速；**解压后的瘦 JAR** 本身就 3.1 → 2.25 秒；应用类归档在中文路径（知趣象限.app）下只归档一小部分
  （64MB / 2.15 秒 vs ASCII 路径 86MB / 1.66 秒，与 locale 无关，软链也不行）→ 外壳把 app 拷一份到 `~/.zhiqu/app/<版本>/` 再跑。
- 归档收尾第一版按 URL 比较，把刚生成的归档当旧的删了 —— `DesktopCdsCacheTest` 红出来。

## 结果
- 全量 779/0/0/0（Docker，Skipped 0）；命令行 160 条（含 21 条替换一致性用例）。
- 扰动：JS 侧 16、Java 侧（替换规矩、网页 agent）12、启动加速（归档规矩、打包前提、ASCII 副本）19，全红；
  另有 1 处扰动一开始不忠实（没复现原 bug）、重做后红。
- 桌面实测（打包产物、临时库、和外壳同样的参数与顺序）：第一次启动 3.6 秒（顺带生成归档，拷副本 0.6 秒），之后 1.6 秒；原来 3.1 秒。
- 应用包 126 → 138MB，dmg 104 → 107MB；用户机器上 `~/.zhiqu/app` + `~/.zhiqu/cds` 约 160MB（删了自动重建）。

## 收口时记在 CLAUDE.md 里的要点

> 第三十八轮（`CLAUDE.md` 瘦身）从 `CLAUDE.md` 原样挪来，一字未改。

### 第十轮（2026-09-28）：网页 code agent 一次做对、写完即查语法、桌面启动快一半

**网页 code agent（`CodeWorkspaceAgent`）追上命令行第九轮的几件事**
- **按原文替换一段**：`write_workspace_file` 原来只收「修改后的完整内容」—— 改 800 行文件里的三行也要整份重写，
  顺手改掉别处、漏一段、撞输出上限都是这里来的。现在 old_string / new_string / replace_all，同一个文件多次替换叠在同一份草稿上；
  替换要先读过、读过之后指纹变了就拒。**规矩只有一套**：`service/workspace/TextEdit.java` 与 `zhiqu-cli/src/tools/edit.js`
  跑同一份 `conformance/text-edit.json`（空白集合两边写死，不用 `\s` —— Java 与 JS 的 `\s` 范围不同）。
- **大文件分段读**（`readSlice`，上限 `ContextBudget.toolOutputChars()`）：读全了原样给，没读全在开头写明第几行、用 offset 接着读；
  只读了一部分不许整份重写（`LoopState.fullyRead`）。原来一次给全文（最多 256KB），一个大文件就撑爆小窗口的模型。
- **工具循环的对话有预算**（`ToolLoopContext`，`toolLoopChars()`）：原来没有上限，每读一个文件多一整份，几个中等文件之后整个请求被拒，
  用户看到「工具循环中断」。超了先省略旧的工具输出（**从最旧的开始、只保最新一条** —— 第一版「最近 4 条原样」时判据就红了：
  一次读能给到预算的一半，4 条原样本身就超预算），再不够省略旧调用里的大段参数（写草稿时的整份文件）。

**命令行：写完立刻查语法**（`zhiqu-cli/src/tools/syntax.js`）：JSON（`JSON.parse`；tsconfig / jsconfig / .vscode 是 JSONC，不查）、
JS（`node --check`，只解析不执行、不带环境变量）。**不能原地 --check .js**：实测 node 22 对带 export 的 .js 连真的语法错误也放行（退出码 0）——
按内容定类型，拷到临时目录用 .mjs / .cjs 查。JSX 报的「Unexpected token '<'」不算错。不查 Python：没装命令行工具的 Mac 上一调 python3 就弹安装框。

**桌面应用启动 3.1 秒 → 1.6 秒**（同一台机器、同一个库、交替实测）
- 应用里放**解压后的瘦 JAR + lib/**（`java -Djarmode=tools extract`），不放胖 JAR：胖 JAR 的类走 Spring Boot 自己的加载器，
  既慢又归档不了。单这一步加上运行时的基础 CDS（jlink `--generate-cds-archive`）就到 2.25 秒，第一次启动就有。
- **应用类归档**在用户机器上生成（`deploy/desktop/macos-shell/CdsCache.swift`）：JDK 17 要求类路径一字不差、应用装在哪打包时不知道。
  第一次运行 `-XX:ArchiveClassesAtExit` 写到 `.part`（JVM 退出时才写，约 3 秒，外壳退出时为这一次多等到 20 秒）；
  **只有正常结束（SIGTERM 后自己退出）才改名成正式归档**，被 SIGKILL 的、空的、上次半截的都删。之后 `-XX:SharedArchiveFile`。
  清旧版本时**按文件名比、不按 URL 比**：`contentsOfDirectory` 给回来的 URL 与自己拼的指向同一个文件也可能不相等 ——
  第一版因此把刚生成的归档当旧的删了，`DesktopCdsCacheTest`（编译 CdsCache.swift + 检查程序、不开窗口地真走一遍）红出来的。
- **中文路径会让应用类归档只归档一小部分**（实测：`知趣象限.app` 里 64MB / 2.15 秒，ASCII 路径 86MB / 1.66 秒；与 locale 无关，软链也不行 ——
  JVM 按真实路径算）。所以外壳把 `Resources/app` 拷一份到 `~/.zhiqu/app/<版本>/` 再跑（`AppStage`；APFS 上是克隆；最后写 `.complete`，
  没标记的当半截；拷不成照原样从应用包跑）。`~/.zhiqu/app` 与 `~/.zhiqu/cds` 共约 160MB，删了下次自动重建。
