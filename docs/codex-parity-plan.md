# 把命令行 agent 做到 Codex 同一级别（2026-11-07）

用户 2026-11-07：「把这个agent优化到市面上的codex相同级别的」。

## 「同一级别」怎么算

只有两条算数，缺一条都不能说「到了」：

1. **能力对照表全绿**（下面的表）：Codex CLI 有、对写代码有用的能力，命令行都有。
2. **同一个模型、同一批题、官方评分**：Codex CLI 和 zhiqu 都接 DeepSeek v4-pro，跑同一批 SWE-bench Verified 题，配对比较，zhiqu 不比 Codex 差到噪声以外。DeepSeek 官方有 [Codex 接入文档](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/)（`wire_api = "responses"`、`model_reasoning_effort = "high"`），不用自己写转换层。

**做不到的事先说清楚**：Codex 默认用的是 OpenAI 自己的模型（文档里是 `gpt-6.1-sol`），harness 再好也不能把 DeepSeek 变成它。不同模型之间比通过率比的主要是模型。公开数字（来源是第三方博客，自己没验过）里，同一个模型换 harness 能差 7 个点左右，换模型差得更多。

## 现状（读代码 + 翻 33 遍真实评测记录，2026-11-07）

- **思考一直关着**：`HarnessModelGateway` 写死 `applyOpenAiReasoningOptions(config, body, "OFF")`（第十二轮用户说 v4-pro「一直在思考循环」关的，之后没量过）。DeepSeek 官方给 Codex 的配置是 `high`。第九十八轮记下的失败多数是「修法判断不对」。**这是最大的嫌疑，要量。**
- **没有 shell**：7 个工具，`run_command` 是命令名 + 参数数组，白名单只有 java / javac / python3 / python / node / npm / go / gcc / g++ / cargo / mvn / git（git 只有 status / diff / log）。没有 grep、find、sed、pipe、cd。225 次跑命令里 96 次是 `python3 -c`（大多是复现，也有 2 次拿它叫 `find`）。
- **auto 档其实没有边界**：`python3 -c` 在 auto 下不问就跑，能读写工作区外的任何文件、能上网。Codex 的 auto 跑在系统沙箱里（macOS Seatbelt、Linux bubblewrap）。这一条既是能力差距，也是**安全差距**。
- **搜索只认字面文本**（210 次），不能正则、不能按文件类型过滤。
- **评测本身有个障碍**：工作目录没有 `.git`（防历史泄漏），`git diff` / `git log` / `git status` 全部退出码 129 / 128 —— 模型看不了自己的改动。真实用户没这个问题，但评测里 harness 被低估了。对照 Codex 时两边要同一个条件。

## 能力对照

| 能力 | Codex CLI | zhiqu | 第几步 |
|---|---|---|---|
| 思考档位 | `model_reasoning_effort` / `/model` | 五档（第一百零八轮）；默认关，量过再定 | 1 |
| 任意 shell 命令 | 有 | 有（第一百零九轮，命令行和网页） | 2 |
| 系统沙箱（写范围、断网） | Seatbelt / bubblewrap / Windows 沙箱 | Seatbelt / bubblewrap；Windows 退回白名单 | 2 |
| 沙箱挡住时问用户放行 | on-request | 命令行 ask 档有；网页没有确认界面 | 2 |
| 正则搜索 | shell 里的 rg | 有（第一百一十轮）：`regex`、`glob`、`.gitignore`，也认草稿 | 3 |
| 一次改多个文件 | apply_patch | 有（第一百一十一轮），全成或全不成，网页进草稿 | 4 |
| 长命令 / 后台进程 | exec 会话、`/ps`、`/stop` | 有（第一百一十二轮，网页同一套）：`background`、`shell_output`、`shell_stop`、`/ps`、`/stop`；不能往进程里写 stdin | 5 |
| 非交互 | `codex exec`：`--json`、`--output-schema`、`-o`、stdin、`exec resume` | 有（第一百一十三轮）：`zhiqu exec`，同样的参数和事件名 | 6 |
| 代码审查 | `/review`、`codex review` | 有（第一百一十四轮）：`zhiqu review`、`/review`，只读、P0–P3、结论回到会话；网页的 `/review` 第一百一十八轮 | 7 |
| 子 agent | 有，默认开，继承权限 | 有（第一百二十三轮，npm 0.2.0）：explorer（真只读）/ worker，继承权限、深度 1、并发 / 个数 / token 上限；能起后台命令、停下前先停掉；网页还没有 | 8 |
| 图片输入 | `--image` | 无 | 9 |
| `/diff`、`/fork`、`/status`、`--cd`、`--add-dir`、`--worktree`、hooks、命令规则 | 有 | 无 | 9 |
| 跑的时候插话（steer） | 有 | 无 | 9 |
| 项目说明、Skills、MCP、压缩、续接、goal、plan、`/usage` | 有 | **有** | — |
| AGENTS.md | 有 | **用户定了不读**（第 P3 阶段） | 不做 |
| 云端任务、IDE、桌面、`/pets` 这类 | 有 | 不做（和写代码的能力无关） | 不做 |

## 步骤（一步一轮，判据先红；做完更新「进度」）

| 步 | 内容 | 怎么验 | 进度 |
|---|---|---|---|
| 1 | **思考档位**：`--effort` / `/effort`，网页输入框下面的按钮（用户定的 instant / medium / high / extra / max）；网关照档位发，回传 `reasoning_content` 和 Claude 的思考块，不收就降 | 假模型真 HTTP；**真模型四题三遍对比（要用户点头花钱）** 决定默认值 | 代码做完（第一百零八轮）；默认值待量 |
| 2 | **`shell` + 系统沙箱**：plan 只读、ask 逐个问、auto 不问但关在工作区且断网；挡住时 ask 档可放行；没有沙箱的平台退回白名单。网页代码模式同一份沙箱（用户 2026-11-07 改的，原来写的是不给），auto 档的 shell 直接写工作区（用户定的） | 真的试写工作区外、读密钥、连网，都要被系统挡住 | 做完（第一百零九轮）；Windows 没有，退回白名单 |
| 3 | `search` 认正则、文件类型过滤、跳过 `.gitignore` | 用例 | 做完（第一百一十轮） |
| 4 | `apply_patch`：一次多文件、要么全成要么全不成，改前给 diff | 用例 + 一致性 | 做完（第一百一十一轮）；模型爱不爱用要真模型量 |
| 5 | 长命令：后台跑、看输出、停，`/ps`、`/stop` | 真进程 | 做完（第一百一十二轮）；还不能往进程里写 stdin |
| 6 | `zhiqu exec`：只把结论写 stdout、`--json` 事件流、`--output-schema`、`-o`、stdin、`exec resume --last`，默认只读 | 端到端 | 做完（第一百一十三轮） |
| 7 | `/review`、`zhiqu review`：只读，给分优先级的发现 | 端到端 | 做完（第一百一十四轮；网页的 `/review` 第一百一十八轮和 `/` 面板一起做） |
| 8 | 子 agent：只读探索、干活两种，继承权限，有并发和预算上限 | 端到端 | 做完（第一百二十三轮，命令行；npm 0.2.0 起才在用户手里，第一百二十六轮）；第一百二十六轮起子 agent 能起后台命令、停下前先停掉自己的（用户定的）；网页的代码模式还没有（没有显示子 agent 的地方）；真模型爱不爱用、用了好不好没量 |
| 9 | 图片、`/diff`、`/fork`、`/status`、`--cd`、`--add-dir`、`--worktree`、插话、hooks、命令规则 | 用例 | |
| 10 | **对照评测**：工作目录给一个只有基线提交的 `.git`；Codex + DeepSeek 和 zhiqu + DeepSeek 同题配对（**要用户点头：装 Codex、花钱**） | 官方评分 | |

## 不能动的

- 服务端工作区的门不变（`docs/notes/code-workspace.md`）：默认关、只认回环地址、要管理员、生产 profile 一律不执行。网页的 `edit_file` / `write_file` 照旧先成草稿；`shell` 按用户定的和命令行一样（auto 档直接写工作区）。
- 「下发给模型的工具」和「能执行的工具」还是同一份清单。
- 第十二、五十四轮关思考的理由（慢、空转）是真的：**默认值量过再改**，改之前默认还是关。
