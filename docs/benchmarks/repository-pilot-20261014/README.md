# 仓库评测（2026-10-14 准备，2026-10-17/18 在个人电脑上跑完）

**结果（第六十九轮）：官方 6/10 resolved**（固定十题、分母不变；官方 v3.0.17 harness、官方 x86 镜像走 Rosetta）。
六题用 ID 6「deepseek测试专用」，第七题起保守额度用完，被打断的四题按用户要求用 ID 1「DeepseekV4pro」（同一个 deepseek-v4-pro）各补跑一次。
解决的：django-15987、sympy-23950、sympy-20154（ID 6）；requests-1921、scikit-learn-10297、scikit-learn-13496（ID 1）。
requests-1724 的补丁对、待修测试全过，只因本机网络（Docker Desktop 经系统代理，httpbin 约 4% 回 502）挂了一条旧测试 —— 记「受网络影响」，网络修好后原样重评。
花费（保守口径）：ID 6 ¥37.66、ID 1 ¥10.03。逐题、对照、例外和花费见 [第六十九轮](../../rounds/round-69.md)，配置与对照结果见 [run-config.json](run-config.json)（`controls_detail`、`controls_exceptions`、`continuation`、`budget.ledger_history`）。

以下是 2026-10-14 公司电脑上的准备记录，原样保留。

**状态（2026-10-14）：公司电脑停止环境准备，待个人电脑继续。未开始正式仓库评测。**
用户已确认本轮模型上限 **¥50**，含校准、失败和重试；目前真实模型请求 **0**、费用 **¥0**。
随后用户收到 IT 警告，不允许下载 Docker，要求推送方案后回家用个人电脑测试。公司电脑不再尝试 Docker 下载或替代安装。

## 已保存的方案与准备结果

- 继续使用 [固定10题](../repository-pilot-20261013/selection.json) 和 [仓库级方案](../repository-eval-plan.md)，不换题、不缩小分母、不重抽答案。
- [run-config.json](run-config.json) 保存 ¥50 授权、400万输入 / 50万输出 token 上限、60轮 / 30分钟 / 180秒单命令和每分钟50次请求；`execution_ready=false`。
- 10份 base 源码已从精确 commit 安全导出，公开档案共 49,953,187 bytes；源树没有 `.git`。这批本机缓存与私有评分数据不提交，个人电脑须按固定来源重建。
- 模型只读检查确认现有 `deepseek-v4-pro` ID1、工具调用启用、1M上下文，没有调用模型生成内容。
- 真实生产 `runTurn / LocalTools / Api / SSE` 的仓库 worker、限定模型 stream 的 broker / 预算账本，以及任务准备 / 补丁收集工具已有离线验证。
- 本机假模型集成实际通过 HTTP broker、生产 Api/SSE、文件工具与公开 Node 检查；它只是运行器验证，不能算 SWE-bench 成绩。

## 准备时修正的协议问题

原方案的评分器 HEAD `02e7a74…` 已改用 `image / eval_script / log_parser / eval_type` 格式，固定的经典 Verified parquet 没有这些字段。正式运行配置改为官方 **v3.0.17**，commit `3f01bd622c0a22c00406139f69a234ef08225f22`，在任何模型调用前完成版本更正；原设计记录保留。

官方评分器会直接跳过空 `model_patch`，所以空 JSONL 不能证明测试见红。准备器另生成不改变业务代码的 noop 补丁，用它验证 base 的测试实际运行并失败；gold 控制必须通过，且真实日志中观察到规定测试结果。缺测试、全部 skip 或解析器依赖不可用都不能当作有效控制。

官方 `resolved` 与额外完整性检查分别保存。真实测试执行未确认时 `ability_rate=null`；不会把读到一个 report 的绿色字段直接当成能力分。

## 工具入口

| 文件 | 功能 | 当前范围 |
|---|---|---|
| [run-repository.mjs](../../../tools/benchmarks/run-repository.mjs) | 固定配置 / 源码、Docker、已有网关的 preflight；公开任务与 base 准备 | 仅 `--preflight / --prepare`，没有付费 `--run` |
| [repository-worker.mjs](../../../tools/benchmarks/repository-worker.mjs) | 单题真实 agent episode，公开 issue + base_repo，临时 capability | 父进程必须先落实容器隔离；不可在宿主机直接接真实模型跑候选 |
| [repository-broker.mjs](../../../tools/benchmarks/repository-broker.mjs) | 精确模型、请求节奏、临时 capability、预留与持久化预算 | 进程边界与假 API 已测，真实 Docker 网络仍待验收 |
| [prepare-repository-eval.py](../../../tools/benchmarks/prepare-repository-eval.py) | 固定私有 snapshot、公开投影、安全源码导出、冻结补丁、官方命令 / report 验证 | 不执行候选；返回官方命令时 `safe_to_execute_unwrapped=false` |

broker按每百万输入未命中 **¥9**、输出 **¥27** 保守记账，缓存优惠不用于放宽额度；未知 usage / 断流保留预留。供应商 usage 超出预留时记录超额并停止后续请求。因此它是调用侧额度控制，不能承诺替代供应商账单硬帽。

同一账本有独占 `.lock`，同时启动另一 broker会拒绝。崩溃后的残留锁须先核实旧进程已退出，再人工只处理锁并恢复原账本；不得删账本来重置预算。

## 个人电脑继续时

个人电脑检出本分支的最新提交，使用 Node 24.19.0、Python 3.9+。推荐 Linux x86_64 Docker；Apple Silicon 的官方仓库镜像支持仍属实验性，须先确认架构和资源。Windows 原生控制脚本未验证，宜使用 Linux 执行环境。

先运行零模型的组件检查：

```bash
node --test --test-reporter=tap tools/benchmarks/run-repository.test.mjs tools/benchmarks/repository-worker.test.mjs tools/benchmarks/repository-broker.test.mjs tools/benchmarks/repository-integration.test.mjs
python3 tools/benchmarks/prepare-repository-eval_test.py
node tools/benchmarks/run-repository.mjs --preflight
```

`--preflight` 的 `ready=false` / 退出码2会列出缺失条件。当前源码即使能访问 Docker，也会拒绝把未验收镜像和隔离控制当成 ready；这个命令不会启动收费请求。

在个人电脑准备 pinned parquet 和独立 PyArrow20.0.0后，可按 [工具说明](../../../tools/benchmarks/README.md) 重新选择公开元数据，再运行 `--prepare`（数据必须在模型容器不可读的控制目录）：

```bash
node tools/benchmarks/run-repository.mjs --prepare \
  --python /absolute/path/to/python3 \
  --parquet /private/control/SWE-bench_Verified.parquet \
  --pyarrow-path /private/control/pyarrow20 \
  --control-dir /private/control/zhiqu-repository-run
```

准备器首次会下载公开 base 档案；它不调用模型或 Docker、不执行仓库源码。固定评分器源码和 Python依赖也放个人电脑的独立控制环境；公司电脑的依赖安装已中断，不能标为已验收。

正式收费运行前还需完成：生成镜像只含 base 和公开依赖、独立 broker、task 网络 namespace规则、整个容器取消回收、可信评分器隔离适配，以及全部10题 noop-red / gold-green控制。完整 Docker编排和一键正式生成入口尚未实现 / 验收；不能直接执行 worker 或未隔离的官方命令来绕过这些条件。

下一步是在个人电脑确认 Docker可用后完成上述集成，校准单列入账，再在 **¥50** 上限内执行固定10题。额度不足时记录 `budget-stopped incomplete run`，不发布缩小分母后的成功率。
