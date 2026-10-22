# 第六十二轮（2026-10-14）：开始仓库级评测准备与运行器实现

## 用户授权

用户要求开始仓库测试，选用第六十一轮固定的 SWE-bench Verified 10题 pilot 与现有 DeepSeek。
用户确认本轮模型费用上限 **¥50**，包含连通校准、失败和重试，达到上限停止。
执行前仍需真正的 Docker 评分环境；本机当前没有 Docker CLI / Desktop / socket，执行位置待用户回复。

## 本轮计划

1. 复核现有网关、模型、固定数据与来源；建立本轮独立控制目录。
2. 并行实现真实仓库 worker、只允许模型 stream 的 broker / 预算账本、可信任务准备 / patch 收集 / 官方评分适配。
3. 先做无模型离线回归和扰动见红，集成入口缺 Docker 或控制证据时明确停止。
4. 在可用 Docker 环境逐题 empty-red / gold-green，验收生成镜像、网络和生命周期隔离。
5. 验收后在 ¥50 上限内校准并运行固定10题，冻结候选再评分；预算不足明确记为未完成，不缩小分母或重抽答案。

## 当前实测

- 本机知趣网关 `127.0.0.1:47615` 正在监听；只读 preflight 确认模型 ID1、`deepseek-v4-pro`、工具调用启用、有效上下文1,000,000。
- 被测生产 CLI source SHA仍为 `f9311d562f60661a85221cf8ae85cb50d8ce2d33dc6dffcec2ef2f34d2b03772`，生产代码干净。
- 本机为 arm64，约322GiB磁盘可用；未发现 Docker CLI / Desktop / socket。
- 官方 Docker ARM64 安装包本日重新检查仍为连接重置。本轮未安装替代虚拟机或绕过网络限制。
- 尚未调用模型，费用记录为0；后续准备和检查在本轮收口时补记。

## 用户随后调整执行位置

用户收到 IT 警告，不允许下载 Docker；明确要求停止公司电脑执行，回家在个人电脑测试，现在推送测试方案。
没有尝试替代安装或继续下载 Docker；正在进行的独立 Python 评分器依赖安装也已中断。它不能被标成已完成 / 通过。

## 已完成的准备与组件

- 固定10题私有 snapshot 和公开四字段任务已准备，10份base源码均安全导出、无.git；公开档案共49,953,187 bytes，仅在私有控制目录保存，不提交隐藏字段或答案。
- 发现设计中的官方HEAD改用新版数据格式，经典 Verified parquet缺字段。任何模型调用前把运行配置固定到官方 v3.0.17 `3f01bd622c0a22c00406139f69a234ef08225f22`，保持原题目 / 模型 / CLI和历史设计记录。
- 官方 harness 会跳过空补丁，补了不改业务行为的noop基线控制；基线红要求真实日志中的失败，不能只信官方将缺失测试也列为failure的名单。
- 仓库worker使用生产runTurn / Api / SSE / LocalTools，公开issue + base_repo，模型 / 上下文核验，禁个人MCP与办公API，capability仅本题。
- broker只允许模型stream，统一限速和整数费用 / token预留、未知usage保守记账、撤销和持久化恢复；真实token不进入候选。假模型接真实Api/SSE的本机集成完成读 / 改 / 执行公开检查，费用模拟值与真实账单严格分开。
- 准备器不执行候选，冻结patch并重新应用比对最终tree，拦路径 / 链接 / 元数据；root审阅又发现大小写别名`.GIT`在macOS可能覆盖可信Git元数据，两项新判据先取得Assertion Failures后修复并全绿。
- preflight实际返回Docker未安装、镜像未冻结、Docker控制未验收和编排未就绪；即使网关正常，也不启动模型。

产物：[个人电脑继续说明](../benchmarks/repository-pilot-20261014/README.md)、[¥50运行配置](../benchmarks/repository-pilot-20261014/run-config.json)。
只读准备入口、worker、broker和可信准备 / patch工具在 `tools/benchmarks/`；没有可直接调用真实模型的完整 `--run` 编排入口。

## 实测与限制

worker13项回归、准备器19项回归、controller7项回归，以及真实Api/SSE与broker的假模型集成均通过，无Docker / 真实模型请求。
worker扰动取得13个Assertion Failures，controller7种guard扰动各见断言红；准备器5个核心guard和2个report反例已见红，root新增元数据大小写别名两项也先红后绿。
最终broker18项与假模型集成1项共同19/19通过，无跳过；补了跨进程独占账本锁，旧的非独占open行为已取得Assertion Failure。
没有把离线fixtures或官方命令语法核对当成SWE-bench正确率。

## 真浏览器验证与最后检查

真实Chromium打开本轮准备状态页，显著显示“待个人电脑继续 / 尚未评分”、真实模型0次 / ¥0和¥50额度；连续刷新5次始终保留10个精确base、未就绪提示，console error / warn为0。
验证后关闭临时标签页和本机静态服务。本页只核对准备状态，没有任何评分或模型调用。
最终联合Node回归39项通过（worker13 / broker18 / controller7 / integration1）、Python准备器19项通过，均无跳过；冻结组件哈希后`execution_ready`仍false。

Docker镜像、实际官方log parser依赖、noop-red / gold-green、网络namespace / 整容器生命周期以及隔离评分适配仍未验收，`execution_ready=false`。
