# 第一百一十三轮（2026-11-07）：Codex 同级第 6 步 —— zhiqu exec

## 由来
方案第 6 步（[`docs/codex-parity-plan.md`](../codex-parity-plan.md)），用户：「接着做第六步」。现在只有 `-p`，给人看的进度和结论都混在 stdout，脚本和 CI 接不了。Codex 有 `codex exec`。

## 计划
1. `zhiqu exec "提示"`：stdout 只有最终结论，进度走 stderr。提示从参数或 stdin 读（都有时 stdin 当材料附在后面）。
2. 默认只读（`plan` 的工具，但不用提交计划，没人批准），`--mode auto` 才能写；`--mode ask` 拒绝：没人能回答确认。
3. `--json`：stdout 是事件流，一行一个 JSON，事件名和 Codex 一样（`thread.started`、`turn.started`、`item.started`、`item.completed`、`turn.completed`、`turn.failed`、`error`）。
4. `--output-schema <文件>`：最终结论要符合这个 JSON Schema。**在客户端校验 + 重试**，不靠模型的 `response_format`（DeepSeek 不支持 JSON Schema），换模型也一样。不符合就推回去，几次还不行退出码 1。
5. `-o <文件>` 把结论写进文件；`--ephemeral` 不留会话。
6. `zhiqu exec resume --last "接着"`、`zhiqu exec resume <id> "接着"`。**不继承上次的档位**：不然一条 resume 就悄悄有了写权限。
7. 退出码：0 成功，1 失败，2 用法不对，130 被中断。
8. 判据：起真的 `bin/zhiqu.js`、接假服务器，看 stdout、stderr、退出码、磁盘。

## 结果
**真跑过的**（真后端网关 + 真命令行，假模型，用脚本砸）
- 管道 + 参数、`--output-schema` + `-o`、`--json`、`resume --last` 都对，一次 0.2 秒。
- 5 MB 的 stdin：正常（原文存成文件，模型分段读）。二进制的 stdin：不炸。17 MB：退出码 2，说超了上限。`-o` 写不了：退出码 1，stdout 没有半截。十个并发：全部成功。

**查出来的**
- 扰动第一批 62 处红 57。绿的 5 处都是判据没照到，**最要紧的是「续接不继承档位」**：判据里那段会话没记录过 auto，所以什么都没测到；代码是对的，但下次改就可能悄悄坏掉，等于一条 `resume` 就有了写权限。补了样本，复验全红。
- 我写判据时用了 `test/exec.test.js` 这个名字，**把进程层那 4 条老判据（不继承环境变量、超时杀进程组、输出上限）覆盖了**。提交前看 `git status` 发现是「已修改」不是新文件，恢复了原文件，新判据改叫 `exec-command.test.js`。新建文件之前要看一眼这个名字有没有人用。

判据：后端全量 1345（1 跳过写明原因）、命令行 389/389、评测工具 102 过 1 跳。

**和 Codex 的差别**
- `--output-schema` 在客户端校验 + 重写：多花一轮，但换哪个模型都一样；只认常用的一部分 JSON Schema 关键字。
- 只读时不额外限制网络和 MCP：网络由沙箱管（默认断），只读的 MCP 工具照给。

**还没做的**
- `-o` 写不了要到最后才发现，token 已经花了。
- 很长的 stdin 存进 `.zhiqu/inputs/`，`--ephemeral` 也留着（`--ephemeral` 只管会话）。

