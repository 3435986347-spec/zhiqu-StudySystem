# 知趣 agent 的 HumanEval 评测

这套脚本评测现有知趣命令行 agent 在官方 HumanEval 164 个 Python 函数题上的文件实现能力。
生成阶段实际调用 `zhiqu-cli/src/agent.js` 的 `runTurn`、生产系统提示、本地工具及知趣模型网关。
每题一次完整 agent episode，可自行读写代码和运行自建检查；官方隐藏测试只在提交后评分，不反馈给 agent。

这是一套明确标注协议的 agent 评测，不是 SWE-bench 的仓库修复分数，也不是纯模型的原始排行榜成绩。

## 准备

- 当前支持 macOS：生成与评分都使用 `sandbox-exec`；评分器会实际验证目录外读、写和 IP 网络被拒绝。
- 使用知趣已有的命令行登录，启动本机服务并在网页配置可调用工具的 DeepSeek 模型。当前 v3 生成器只接受 HTTP(S) 的 loopback 网关（`localhost` / `127.0.0.1` / `::1`），其他主机在调用模型前明确拒绝。
- Node 18.17+、Python 3.9+；评分直接使用上游 `human_eval.execution.check_correctness`，不需要安装上游聚合 CLI 的 `fire` / `tqdm`。
- Python 命令需直接指向真正的解释器可执行文件，例如 bundled runtime 的 `dependencies/python/bin/python3` 或已有的直接 runtime。macOS 的 `/usr/bin/python3` 可能是启动器，不适用于当前任务执行白名单；不要把它作为任务的 Python runtime。
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
python3 tools/benchmarks/score_humaneval_test.py
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

默认每题最多 20 轮、300 秒，两个并发 episode。当前协议 v3 默认合计每分钟 50 次模型请求，
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

## 重建本轮报告

`build-humaneval-report.py` 支持完整 v2/v3 + `deepseek-v4-pro` 协议：164 题，每题一次 episode，有效上下文 1,000,000 tokens，20 轮 / 300 秒 / 2 并发 / 50 requests/min。它用 Python 3.9+ 标准库，不调用模型、不执行候选、不读取隐藏题集、不重新评分；其他模型、协议、子集或限制会明确拒绝。

先完成正式生成和评分，再把对应的评分器自测结果放进该运行目录：

```bash
cp /private/tmp/zhiqu-humaneval-assets/verifier-self-test.json /private/tmp/zhiqu-humaneval-run/verifier-self-test.json
python3 tools/benchmarks/build-humaneval-report.py \
  --run-dir /private/tmp/zhiqu-humaneval-run
```

若需要把无效校准的额外用量列入成本估计，追加 `--pilot-dir /private/tmp/zhiqu-humaneval-calibration`。预跑不会进入正式分数，也不会选择重跑中较好的候选。

用户提供费用统计时可同时传入校准目录和 `--cost-stats`：

```bash
python3 tools/benchmarks/build-humaneval-report.py \
  --run-dir /private/tmp/zhiqu-humaneval-deepseek-v4-pro-20261013-paced \
  --pilot-dir /private/tmp/zhiqu-humaneval-deepseek-v4-pro-20261013 \
  --cost-stats docs/benchmarks/humaneval-20261013/user-reported-cost.json
```

生成器核对用户提供的 tokens 等于正式加校准的记录合计，再展示费用、API 请求数和 tokens。统计标记为用户提供、非独立账单核验；API 侧请求数与包含重试、限流的本地网关尝试数分开列出。官网单价的理论区间继续作为参考，不覆盖用户提供的统计。

生成器读取 `manifest.json`、`score.json`、自测报告、各题 `result.json` / `public-task.json`，并只对协议失败读取最终 `workspace/solution.py` 做字节前缀复核。它先核对全部 164 题、模型、计数、哈希及请求/token 合计，再输出运行目录中的 `summary.md`、`metrics.json`、`tasks.csv`、`report.html`。报告页内嵌全部 CSS / JavaScript，支持任务搜索、通过/失败筛选和失败原因展开。

`protocol_error` 不一定表示文件前缀变化。报告区分 `prefix_protocol_failures` 与 `other_protocol_failures`；例如实际模型 start 事件缺失、没有实现的失败保持原生成错误，不计作算法或官方断言失败。

报告按 `manifest.version` 标识来源：v2 明确属于防御修复之前的协议；v3 只使用该运行自己的实际产物，不继承 v2 的 95.12%。本仓库目前只保存真实 v2 评测成绩，报告生成器支持 v3 不表示 v3 已用模型重测。

2026-10-13 的 **95.12% 是修复前冻结 v2 的历史结果**。当前可运行工具为 v3，追加了评测后防御修复，尚未取得重跑后的能力分；没有调用模型重跑或改分。原始正式 `manifest.json`、`score.json` 和指纹保持不变，旧的 6 个工具文件按原字节保存在 [历史文本快照](../../docs/benchmarks/humaneval-20261013/protocol-v2/README.md) 中，供审计，不作为运行入口。原始会话和候选继续留在本地忽略的归档中。

官方来源：https://github.com/openai/human-eval 。题目与检查器按上游 MIT License 使用；分享含原始题目的产物时附上上游 `LICENSE`。

## 后续仓库级评测（设计阶段）

[仓库级方案](../../docs/benchmarks/repository-eval-plan.md) 采用固定 SWE-bench Verified 10题 pilot，精确清单和未就绪的设计协议在 [repository-pilot-20261013](../../docs/benchmarks/repository-pilot-20261013/selection.json)。仓库 worker、broker 和官方评分集成尚未实现；本目录现有 HumanEval 运行器不能直接拿来跑仓库 issue。

`select-sweverified.py` 只读取已经下载的 pinned parquet，不联网、不调用模型、不使用 Docker。只解码四个公开字段，按固定 hash 各选两题，校验500题 / 唯一ID / base / 原始文件SHA，输出可公开的 `selection-metadata.json` 和不应公开提交的 issue 全文 `public-tasks.jsonl`。源数据含隐藏判据，准备器数据和输出都放在生成容器不可读的控制目录。

数据集 revision 是 `c104f840cc67f8b6eec6f759ebc8b2693d585d4a`。从官方读取 metadata 和该 revision 的 data tree：

- `https://huggingface.co/api/datasets/princeton-nlp/SWE-bench_Verified/revision/c104f840cc67f8b6eec6f759ebc8b2693d585d4a`
- `https://huggingface.co/api/datasets/princeton-nlp/SWE-bench_Verified/tree/c104f840cc67f8b6eec6f759ebc8b2693d585d4a/data`
- parquet 完整 URL 和 SHA 见 selection.json 的 `source`。

选择器要求 Python 3.9+ 和固定 PyArrow 20.0.0。可使用已有符合版本的环境；如需依赖，放独立临时 `pip --target` 目录，再用 `--pyarrow-path` 指定，无需修改项目依赖。以下只是元数据选择，路径换成自己的控制目录：

```bash
python3 tools/benchmarks/select-sweverified.py \
  --parquet /private/tmp/zhiqu-swe-verified-c104f840.parquet \
  --dataset-meta /private/tmp/zhiqu-swe-verified-dataset-meta.json \
  --data-tree /private/tmp/zhiqu-swe-verified-c104f840-data-tree.json \
  --pyarrow-path /private/tmp/zhiqu-swe-parser-deps \
  --output-dir /private/tmp/zhiqu-swe-selection
```

`public_index_sha256` 对500行四字段按 instance_id 排序、compact sorted-key UTF-8 JSON + LF 计算；`public_projection_sha256` 对输出10行的实际字节计算。每题另外记录 issue 原始 UTF-8 和选择 hash。选择器源码hash单独保存，变更后不能悄悄沿用旧脚本指纹。
