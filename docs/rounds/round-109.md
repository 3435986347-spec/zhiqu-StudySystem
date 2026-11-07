# 第一百零九轮（2026-11-07）：Codex 同级第 2 步 —— shell 与系统沙箱

## 由来
方案第 2 步（[`docs/codex-parity-plan.md`](../codex-parity-plan.md)）。现状有两个问题：
- 能力：`run_command` 只有白名单，没有管道、grep、find、cd。真实评测里 225 次跑命令有 96 次是 `python3 -c`，有的就是拿它叫 `find`。
- 安全：auto 档的 `python3 -c` 不问就跑，能读写工作区外的任何文件、能上网，**只有规则，没有系统隔离**。Codex 的 auto 跑在系统沙箱里。

做到一半用户说：「网页代码模式也要给系统沙箱，两者要一致」，改掉了原方案「网页不给」。问过三选一（临时副本 / 真工作区只读 / 和命令行完全一样）后用户定了**和命令行完全一样**：auto 档的 `shell` 直接写工作区，不经过草稿。

## 计划
1. `shell` 工具：一条 bash 命令，管道、重定向、`&&` 都能用。有系统沙箱才给，给了就不再给 `run_command`（一份清单）。命令行和网页同一个工具。
2. 系统沙箱（`zhiqu-cli/src/tools/sandbox.js`，一份实现）：macOS 用 Seatbelt，Linux 用 bubblewrap。真跑一次探测，起不来就当没有。网页由后端问这份实现「怎么起」（`host/sandbox-launch.js`），进程还是 `WorkspaceExecutor` 起，门还在后端。
3. 边界：写工作区和自己的临时目录（`.git`、`.zhiqu` 不行，`/tmp` 不给）；读不到家目录（工具链除外，凭据再挡一遍）；默认全断网，包括本机；`open`、`osascript`、`launchctl`、剪贴板、钥匙串、别的进程都挡。
4. 档位：plan 只读沙箱，不问；ask 逐个问；auto 不问。被挡住时 ask 档问要不要不带沙箱再跑一次（默认不），auto 和 plan 只告诉模型。网页 manual 没有确认界面，用只读沙箱。
5. 没有沙箱的平台（Windows、没装 bubblewrap 的 Linux）退回白名单。
6. 验证：真的试写工作区外、读密钥、连网、叫系统服务；真工具链（git、python、node、npm、java、mvn、clang）在沙箱里要能跑；Linux 在容器里真跑。

## 结果
边界和档位写在 [`docs/notes/code-workspace.md`](../notes/code-workspace.md)。

**真跑查出来的错（每一条读代码都看不出来）**
- **执行器启动时存死档位和路径**（原来就有的）：以 EXEC 起的后端切到只读还能跑命令、换了项目命令还跑在旧目录。本机验证都带 `--app.workspace.mode=EXEC` 启动，一直没发现。
- **`deny default` 拦不住 `process-info`**：沙箱里读得到别的进程的路径和命令行（令牌常在那里）。第一版判据的靶子进程写错了，一启动就退出，「读不到」被算成挡住了；扰动之前补判据时发现。现在靶子是活的，沙箱外读得到当对照。
- `lsof`、`launchctl print`、`defaults` 第一版都读得到东西。`launchctl` 的专门规则后来删了：加了 process-info 之后 `print`、`bootstrap`、`submit` 全都不通，那条多余。
- **命令退了、后台进程攥着管道，输出全丢**（真浏览器：`sleep 20 & echo x` 模型只看到「没有输出」）。读线程读到多少算多少；命令结束时收掉它起的后台进程，命令行和网页一样。
- Linux：bubblewrap 挡不住还不存在的路径（`.zhiqu` 建得出来），放只读的空目录占住、跑完收掉；家目录在沙箱里是空的，被挡的样子是「没有这个文件」，认出来；**写错的网络配置值会把网打开**（`!== 'off'`），认不出的一律断网。
- 系统工具不听 `TMPDIR`：`xcrun` 每次报一行错、`mktemp` 失败，按名字放；Java 用 `JAVA_TOOL_OPTIONS`。
- **JVM 附加到自己被挡，故意不放**（Mockito 5 的 inline mock maker）：要连 `.java_pid` socket，别的 JVM 的也在那儿，放开就能跳出沙箱。用到的测试在沙箱里跑不过，写在说明里。
- 探测一坏，判据文件就整个跳过、看着和通过一样（扰动「探测总说没有」时发现）：macOS 上探测不到直接红，要跳过得写明。

**真跑过的**
| 档位（网页，真点按钮，假模型把命令交给 shell） | 模型拿到 | 结果 |
|---|---|---|
| auto | read / write / edit / shell | 文件落盘；写 `~/` 外、读 `~/.zhiqu/config.json`、`curl` 都被挡；`git` 正常 |
| plan | read / shell | 写工作区被挡，文件一字没变，`$TMPDIR` 能写 |
| manual | read / write / edit / shell | shell 只读 |
| close | 没有工具 | 没有文件 |

暴力：300 万字节输出如实标截断、退出码 7 带回来、后台进程收掉、攥管道不丢输出、`mkdir .git`、`.zhiqu/settings.json`、`git init` 都被挡。真工具链：真仓库上 `git log / status / diff`（几十毫秒）、`grep`、`find`、Python；`mvn -o test` 能编译能跑（只有 Mockito inline 跑不过）；`node --test` 起本机服务的测试断网时红、`local` 时全过。Linux：`node:22` 容器里装 bubblewrap，判据 25 过 2 跳过（都是 macOS 专属）。

扰动：第一批 81 处红 71。绿的 10 处逐条查了：6 处是判据没照到（探测一坏整个文件跳过、路径存死、家目录这些，都补了）、1 处真漏洞（写错的网络值开了网）、2 处防护重复（删了）、1 处确认是两层（两层一起放才红）。复验 + 新增 19 次（含后台进程、读管道、整个应用接上 shell）全红。

判据：后端全量 1339（1 跳过写明原因）、命令行 333/333、评测工具 102 过 1 跳。

**还没做的、做不到的**
- Windows 没有沙箱，退回白名单。
- 网页 manual 没有逐条确认的界面，所以 shell 只读；网页也没有「不带沙箱再跑一次」。
- `(sleep 100 &)` 这种脱离了 shell 的进程：命令行超时时连进程组收掉；网页收不掉（Java 拿不到已退出进程的子孙），它还是关在沙箱里，跑完自己退。第 5 步一起处理。
- 桌面应用要重新打包才带上（用户跑 `bash deploy/desktop/package-macos-native.sh`）。
- 首页轮播截图要重出（改了 AI 助手的输入框，要开窗口，先问用户）。第一百零八轮的真模型对比也还等用户点头。
