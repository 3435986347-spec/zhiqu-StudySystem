# 第六十一轮（2026-10-13）：仓库级 coding agent 评测设计

## 用户要求与范围

HumanEval review / push 收口后，用户要求继续设计仓库类型测试，并提供本次实际费用 ¥9.51、API 请求 1,292、tokens 4,743,272。
本轮完成可审阅的选题、协议与实施方案；不启动新的付费运行，不安装 Docker，不启动桌面应用或改写用户业务数据。

## 计划

- 主评测选官方 SWE-bench Verified，固定数据 revision 和确定性 10 题 pilot，后续 50 / 500 题另立协议。
- 真实知趣 `runTurn` / Api / LocalTools 不改能力；生成、模型 broker、可信 patch 收集与官方评分隔离。
- 明确官方 resolved、完整测试 / 构建和环境错误的不同含义；empty-red / gold-green 控制必须先过。
- 本项目 Java / JS 六题仅定义补充槽位，独立计分；有真实或明确 seeded 缺陷及红绿判据后才能开始。
- 固定费用和执行环境的缺口，Docker 下载失败不妨碍设计。

## 设计产物

[详细方案](../benchmarks/repository-eval-plan.md)、[固定 10 题元数据](../benchmarks/repository-pilot-20261013/selection.json)、
[机器可读设计协议](../benchmarks/repository-pilot-20261013/protocol.json)、[只读选择器](../../tools/benchmarks/select-sweverified.py)。
运行器 / broker / 官方评分集成尚未实现和验收，`execution_ready=false`；这些文件不是新增仓库评测成绩。

## 已取得的证据

- HumanEval 提交 `86a4a3c16a226c7464b3023d2bb63ad5c3d810d9` 已推送，SSH `ls-remote` 核对远端分支同一 SHA。
- 固定 Verified revision `c104f840cc67f8b6eec6f759ebc8b2693d585d4a` 的原始 parquet 为 2,096,679 bytes，SHA-256 `a45b1fe4e2f0c8390b2b2938ac83e92ed5979000856808f3679c07812e9e6dcd`，与官方 LFS OID 相同。
- 实际 500 题、唯一 ID / 合法 base；只解码 repo、instance_id、base_commit、problem_statement 四列，不输出隐藏 patch / test / F2P / P2P。
- PyArrow 20.0.0 仅安装到临时目录，没有修改项目或全局依赖。所选五仓库各两题；固定 IDs 和全部仓库数量见 selection.json。
- 独立审阅指出 internal network 不能独自隔离宿主机，已将 task namespace 的 OUTPUT 默认拒绝、DNS / IPv6 拒绝、broker 端口例外和实际 namespace 探针写入方案。
- 生成镜像不能继承带答案的 grader 镜像；同 UID 子命令可能拿到 episode capability，必须由独立 broker 对所有请求计量，真实登录不进入候选环境。
- 本机 ARM64 Docker 下载域名经 HTTP/2、HTTP/1.1 都连接重置，官方文档请求成功；只能支持“下载链路 / 域名受限可能较大”，不能据此断定公司策略。

## 真浏览器暴力复核

重新打开已推送的 HumanEval 静态报告，首屏可直接看到冻结 v2 历史口径和用户 ¥9.51 统计。
连续三轮切换失败 / 生成 / 官方检查 / 全部，分别显示 8 / 6 / 2 / 164；搜索 `/132` 显示 1 题，刷新恢复 164。
控制台 error / warn 为零。验证后关闭临时页面与本机静态服务；没有重新调用模型、改分或改产品前端。

## 收口验证

固定 parquet 选择结果经行序逆转仍相同；重复 ID、非法 base、额外隐藏字段和缺一行这四个拒绝判据，先对关闭 require 的临时实现取得 4 个 Assertion Failures，再对正式实现全部通过。
实测核对 500 行 / 全仓计数 / 10 题 ID / issue 哈希、选择器与生产源码指纹、协议分母、空预算和未就绪状态、文档链接与 CLAUDE 行数，全部通过。
JDK17 下 `ClaudeMdTest,SourceTreeCleanlinessTest,NoCommittedSecretsTest` 共 7 项通过，Failures / Errors / Skipped 均为 0；`git diff --check` 通过。
独立审阅发现“全部控制不消耗模型费用”的文字不准确，已明确合法真实 stream 校准须在预算确定后另行入账；本轮仍没有调用模型。
仓库评分的 empty / gold、容器、网关和预算控制属于执行前待验收项，不能把本轮文档检查写成它们已经通过。
