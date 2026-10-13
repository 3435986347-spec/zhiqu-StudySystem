# 知趣 CLI × DeepSeek-v4-pro · HumanEval 跑分

**156/164（95.12%）单次 agent episode 成功。**

**用户提供费用 ¥9.51（含校准），1,292 API 请求，4,743,272 tokens。**
Token 合计与正式运行加校准记录一致；这是用户提供的统计，未独立核验账单。API 侧请求数与本地 1,508 次网关尝试（正式 1,232 + 校准 276）口径不同，不能混算。

这是 HumanEval 的 164 道 Python 函数实现题，通过知趣原有 agent 循环读写文件并调用本地工具，最终由官方隐藏测试评分。它测量模型与知趣工具循环的组合，不能当作 SWE-bench 仓库修复成绩或纯模型 leaderboard 排名。

95.12% 是 2026-10-13 评测后防御修复之前的冻结 v2 历史结果。当前可运行工具已更新到 v3 并追加评测后防御修复，没有调用模型重新跑、修改候选或改分；原始 manifest、score 与证据指纹保持不变。 [冻结 v2 文本证据](protocol-v2/README.md)。

- 生成成功 158/164；生成或协议失败 6 题；生成后未通过官方检查 2 题。
- 分母始终是 164，包含原始 prompt 前缀被改动的协议失败。每题一次 episode；没有隐藏测试反馈、重跑择优或 best-of 合并。
- 协议失败单列：5 题，其中前缀修改 5 题，其他协议失败 0 题。已逐字节复核 HumanEval/34、HumanEval/47、HumanEval/83、HumanEval/110、HumanEval/150：均删除了一个开头换行，通常不影响 Python 语义，属于格式/指令遵循失败；仍按既定协议计失败，不修复重试。
- 时间：2026-10-13 17:10:07 CST 至 2026-10-13 17:41:32 CST；总耗时 31.4 分钟；单题中位数 16.89 秒，p95 26.22 秒（nearest-rank）。
- 模型 `deepseek-v4-pro`，有效上下文 1,000,000 tokens；知趣 CLI commit `a0fc5e2cd48e5f1ed1446ea4a4ff171d6dd6304a`（dirty=False）。
- 单题最多 20 轮、300 秒；并发 2；每 worker 最小请求间隔 2.4 秒，目标合计不超过 50 requests/min；官方测试超时 3 秒。

| 指标 | 合计 | 每题中位数 | 每题 p95 |
|---|---:|---:|---:|
| 模型请求 | 1,232 | 7.0 | 9 |
| 工具调用 | 1,069 | 6.0 | 8 |
| 输入 tokens | 4,396,616 | 23,140 | 36,937 |
| 输出 tokens | 146,684 | 668 | 1,361 |

Token 口径：网关记录的供应商报告 tokens；供应商报告 1232 次请求、网关估算 0 次、usage 口径未知 0 次；0 个任务包含估算，0 次请求缺少 usage。

正式运行费用范围：高峰 **¥5.28–¥43.53**；半价离峰 **¥2.64–¥21.77**。按每百万 tokens：输入缓存未命中 ¥9、缓存命中 ¥0.3、输出 ¥27。缓存命中明细和实际计费时段未知，这只是区间估计，不是精确账单。

前置预跑另用了 194,498 输入 / 5,474 输出 tokens（estimated=True，276 次模型请求），不进入正式成绩。
正式运行加预跑的费用范围：高峰 ¥5.49–¥45.43；半价离峰 ¥2.74–¥22.71。

## 失败题

| 任务 | 函数 | 生成状态 | 官方检查状态 | 原因 |
|---|---|---|---|---|
| HumanEval/34 | `unique` | protocol_error | generation_failed | Final solution.py changed the official prompt prefix；删除了一个开头换行（first_difference_byte=1），通常不影响 Python 语义；这是格式/指令遵循失败，不据此判定算法错误。 |
| HumanEval/47 | `median` | protocol_error | generation_failed | Final solution.py changed the official prompt prefix；删除了一个开头换行（first_difference_byte=1），通常不影响 Python 语义；这是格式/指令遵循失败，不据此判定算法错误。 |
| HumanEval/83 | `starts_one_ends` | protocol_error | generation_failed | Final solution.py changed the official prompt prefix；删除了一个开头换行（first_difference_byte=0），通常不影响 Python 语义；这是格式/指令遵循失败，不据此判定算法错误。 |
| HumanEval/110 | `exchange` | protocol_error | generation_failed | Final solution.py changed the official prompt prefix；删除了一个开头换行（first_difference_byte=0），通常不影响 Python 语义；这是格式/指令遵循失败，不据此判定算法错误。 |
| HumanEval/120 | `maximum` | completed | test_failed | 官方断言未通过（检查器无额外错误文本） |
| HumanEval/125 | `split_words` | completed | test_failed | 官方断言未通过（检查器无额外错误文本） |
| HumanEval/132 | `is_nested` | round_limit | generation_failed | 达到20轮上限，最后仍在工具调用，自建检查/参数修正未收尾。完整性备注：Final solution.py changed the official prompt prefix；删除了一个开头换行（first_difference_byte=0），通常不影响 Python 语义；这是格式/指令遵循失败，不据此判定算法错误。 |
| HumanEval/150 | `x_or_y` | protocol_error | generation_failed | Final solution.py changed the official prompt prefix；删除了一个开头换行（first_difference_byte=0），通常不影响 Python 语义；这是格式/指令遵循失败，不据此判定算法错误。 |

## 复现证据

官方 checker commit `6d43fb980f9fee3c892a914eda09951f772ad10d`，原始数据 SHA256 `b796127e635a67f93fb35c04f4cb03cf06f38c8072ee7cee8833d7bee06979ef`。
CLI source SHA256 `f9311d562f60661a85221cf8ae85cb50d8ce2d33dc6dffcec2ef2f34d2b03772`；adapter SHA256 `9f02aa25d48a040ba7429b80f30ebfde0f7ac3bbbe50ecc8044cbbfd2f595eae`；系统 prompt SHA256 `cf8ecf74202afa4fee6beba42f578b1dcac521f70a58e2e3a56c592bf9758c95`。
所有 164 个任务、计数、模型标识、公开 prompt 哈希、生成/评分 solution 哈希及 tokens/request 合计一致性均已断言。
canonical 自检 164/164 通过，错误实现确实触发断言；正式 agent 和评分器分别在 macOS 文件/网络隔离中执行。
公开题可能出现在训练材料中，本次禁止隐藏测试反馈不等于证明没有训练污染。

[交互报告](report.html) · [任务 CSV](tasks.csv) · [机器可读指标](metrics.json)
原始生成和会话结果目录：`/private/tmp/zhiqu-humaneval-deepseek-v4-pro-20261013-paced`。

来源：[HumanEval](https://github.com/openai/human-eval)、[官方 checker](https://github.com/openai/human-eval/blob/6d43fb980f9fee3c892a914eda09951f772ad10d/human_eval/execution.py)、[DeepSeek 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。
