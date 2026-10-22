# 冻结 v2 的历史文本证据

2026-10-13 的 **156/164（95.12%）** 是评测后防御修复之前的冻结 v2 历史结果。当前 `tools/benchmarks/` 中的可运行工具为 v3，已追加评测后防御修复，尚未取得重跑后的能力分；没有调用模型重新跑、修改候选或改分。

此目录保留正式评测时的 6 个工具文件，原文件名后加 `.txt`，文件权限为 `0644`。它们仅用于文本审计，不是运行入口，不执行这些快照。`snapshot.json` 是原始索引，按原文件名记录字节 SHA-256；对应 `.txt` 的内容与原文件逐字节相同。

- 被测 CLI 基线：`a0fc5e2cd48e5f1ed1446ea4a4ff171d6dd6304a`。
- 原适配器 SHA-256：`9f02aa25d48a040ba7429b80f30ebfde0f7ac3bbbe50ecc8044cbbfd2f595eae`，由 `agent-worker.mjs` 与 `run-humaneval.mjs` 的文件名和字节哈希汇总。
- 原始 [manifest](../manifest.json)、[score](../score.json) 及其中的数据、源码、提示和检查器指纹保持不变。当前代码不应被视为已用真实模型取得该历史分数。
- 候选代码、公开题目、会话和终端日志留在本地忽略的归档中；[归档索引](../local-archives.json) 保留字节数和 SHA-256，不提交原始答案或用户凭据。

报告可用当前的 `tools/benchmarks/build-humaneval-report.py` 从这次完整的本地原始结果重建；这只读取证据，不执行候选、不访问模型、不重新评分。具体命令见 [评测工具说明](../../../../tools/benchmarks/README.md)。
