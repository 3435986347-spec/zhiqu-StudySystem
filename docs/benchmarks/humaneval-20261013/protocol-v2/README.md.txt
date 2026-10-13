# 知趣 agent 的 HumanEval 评测

这套脚本评测现有知趣命令行 agent 在官方 HumanEval 164 个 Python 函数题上的文件实现能力。
生成阶段实际调用 `zhiqu-cli/src/agent.js` 的 `runTurn`、生产系统提示、本地工具及知趣模型网关。
每题一次完整 agent episode，可自行读写代码和运行自建检查；官方隐藏测试只在提交后评分，不反馈给 agent。

这是一套明确标注协议的 agent 评测，不是 SWE-bench 的仓库修复分数，也不是纯模型的原始排行榜成绩。

## 准备

- 当前支持 macOS：生成与评分都使用 `sandbox-exec`；评分器会实际验证目录外读、写和 IP 网络被拒绝。
- 使用知趣已有的命令行登录，启动对应服务并在网页配置可调用工具的 DeepSeek 模型。
- Node 18.17+、Python 3.9+；评分直接使用上游 `human_eval.execution.check_correctness`，不需要安装上游聚合 CLI 的 `fire` / `tqdm`。
- 把官方仓库和包含隐藏测试的题集放在任务目录之外，并且不能放进沙箱允许读取的系统、运行时或源码目录。

```bash
git clone https://github.com/openai/human-eval.git /private/tmp/zhiqu-humaneval-assets/human-eval
git -C /private/tmp/zhiqu-humaneval-assets/human-eval checkout 6d43fb980f9fee3c892a914eda09951f772ad10d
node tools/benchmarks/run-humaneval.mjs --preflight --model-id 1
```

模型 ID 来自自己账号的 `zhiqu models`，不能把模型名称当作 ID。脚本只接受 DeepSeek，并在每次请求中核对实际模型，禁止回退到默认模型。
读取已有登录不会改写用户配置；令牌经子进程 stdin 传递，不能把 Key 或令牌写进报告或命令行参数。

## 先验证评分器

```bash
python3 tools/benchmarks/score_humaneval.py \
  --human-eval-repo /private/tmp/zhiqu-humaneval-assets/human-eval \
  --dataset /private/tmp/zhiqu-humaneval-assets/human-eval/data/HumanEval.jsonl.gz \
  --self-test --output /private/tmp/zhiqu-humaneval-assets/verifier-self-test.json
node --test --test-reporter=tap tools/benchmarks/agent-worker.test.mjs
```

自测要求 164 个标准实现全部通过、错误实现被真实测试拒绝，并检查缺题、网关错误及代码哈希不一致的计分。
外层已有系统沙箱的工具环境可能不允许再次启动 `sandbox-exec`，此时需要让运行器在外层沙箱之外启动；任务与评分子进程仍应用各自的系统沙箱。脚本不自动回退到无隔离执行。

## 生成与评分

```bash
node tools/benchmarks/run-humaneval.mjs \
  --dataset /private/tmp/zhiqu-humaneval-assets/human-eval/data/HumanEval.jsonl.gz \
  --model-id 1 --requests-per-minute 50 --output /private/tmp/zhiqu-humaneval-run
python3 tools/benchmarks/score_humaneval.py \
  --human-eval-repo /private/tmp/zhiqu-humaneval-assets/human-eval \
  --dataset /private/tmp/zhiqu-humaneval-assets/human-eval/data/HumanEval.jsonl.gz \
  --samples /private/tmp/zhiqu-humaneval-run/samples.jsonl \
  --output /private/tmp/zhiqu-humaneval-run/score.json
```

默认每题最多 20 轮、300 秒，两个并发 episode。协议 v2 默认合计每分钟 50 次模型请求，
每个槽的请求起始间隔至少 2400 毫秒，包括重试与跨题切换的等待；节奏参数记录在 `manifest.json`。
`--runtime-root` 可指定工具依赖所在目录；使用 Codex bundled runtime 时传整个 `dependencies` 目录，Node 与 Python 子命令会从其中查找。
`--dry-run` 只核验题集和协议，不访问网关、不调用模型。`--limit` 仅用于流程试跑，结果必须注明子集，不能当成全量成绩。

`solution.py` 以题目原始 prompt 初始化，agent 必须原样保留前缀并补上实现；评分器再核对 prompt + completion 的 SHA-256。
只提供公开题目和入口函数；禁用远程办公工具、MCP、个人 Skills / 说明和网页存档，避免评测读写真实任务、Wiki 或 Notebook。

## 产物和报告口径

- `manifest.json`：数据、源码、提示及适配器指纹，实际模型，环境、限制、汇总用量与时间。
- `samples.jsonl`：一题一个 completion；未执行、失败、中断均保留记录。
- `tasks/HumanEval-*/`：公开题目、最终代码、本地 session、工具调用、模型请求与终端日志。
- `score.json`：官方 checker 的逐题结果、错误分类、固定 164 题的分母与通过率。

同一协议可断点续跑，已保存的失败不会重新抽一次；数据、模型、提示、源码或限制改变时必须使用新目录。
运行器退出码为 0 只说明生成结束，不说明代码正确；最终以隐藏测试评分为准。验证器基础设施出错时不发布通过率。
用量的 `estimated` 标记必须保留，缓存命中详情与精确扣费仍以模型供应商账单为准。

官方来源：https://github.com/openai/human-eval 。题目与检查器按上游 MIT License 使用；分享含原始题目的产物时附上上游 `LICENSE`。
