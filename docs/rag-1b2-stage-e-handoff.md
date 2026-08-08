# 1B-2 Stage E 交接单（1b / 1c 未做）

写在这里而不是留在对话里：其中至少两条是 Stage E-1a 期间才查出来的，
重新推一遍的成本不低。

## 已完成

| 阶段 | 内容 | 提交 |
|---|---|---|
| A/B | `app/main.py` 特征基线（零覆盖 → 31 条）+ delete scope 定义收敛 | `873d5bb` |
| D | sidecar 契约换 unit 方言（**跨过不可逆点**） | `9e40c75` |
| D 收尾 | fence key 共享构造器 | `ceef60f` |
| E-1a | `DELETE_SCOPE` 闭环 + `RagOperation` 枚举 | `f40f47d` |

回滚锚点：tag `1b-1-rollback-verified`（演练四步全绿 + 决定性扰动）。

**当前 HEAD 是已知不可工作状态**：Java 侧的删除已换 unit 方言，但索引侧仍发
`sourceId`（会被 sidecar 以 422 拒绝），检索侧仍按 `sourceIds` 查询。
这是方案预告的「两个半边物理上不存在都绿的中间态」，由 1b / 1c 补齐。

## 1b：unit 索引路径

`RagIndexWorker.upsertUnit()` 现在只调 `refreshUnitIfLive` 刷投影，**不发任何
sidecar 请求**。要造的链路：

1. 取投影行，必须 `status='READY'`
2. 经 `UnitContentResolver` 解析正文 —— 三态 `OK / GONE / UNUSABLE` **必须分开处理**：
   `GONE` 走退役（页真的没了），`UNUSABLE` 走跳过重试（这次读不到）。
   合并两者就是 Task 12 修掉的那个缺陷：软删页被记成 SKIPPED，向量永不删除。
3. 按 `rag_unit_chunk` 的 `char_start / char_end` 切片重建父块 ——
   **偏移是 code point**，Java 要用 `offsetByCodePoints`，直接 `substring` 会在
   emoji 与代理对上错位（`rag-service/tests/test_offset_parity.py` 与
   `OffsetParityTest` 共读同一份 fixture）
4. 带 unit 方言发 `/v1/index/sources`，payload 形状见 `rag-service/app/main.py`
   的 `IndexRequest`

### 四条硬约束

**① `mutationToken` 必须是 `job.getId()`。**
全仓三处 legacy 路径同源（`RagIndexWorker:168 / :205 / :250`）。

*不要把理由记成「job id 的序就是提交序」—— 那是错的。*
InnoDB 在 INSERT 语句执行时就分配自增值，而事务可以在之后、且乱序地提交：
事务 A 拿到 id=100 后继续干活、t=5 提交；事务 B 拿到 id=101、t=3 提交。
B 先提交却是更大的 id。拿自增 id 当逻辑时钟是经典陷阱。

真正的性质是两条：

- **索引与删除共用同一个单调序列**；
- **两个序分歧时，两种乱序都倒向「删除获胜」**：
  - 删除 id 小、后提交 → worker 先看到索引作业（还没有 fence 记录）→ 索引通过
    → 随后删除执行并删掉向量 → 删除获胜；
  - 删除 id 大、先提交 → fence 记为 101 → 索引作业 100 后到，
    `100 <= 101` → 判为陈旧丢弃 → 删除获胜。

按这个措辞记，是因为「等于提交序」会让人以为任何别的「也等于提交序」的东西
可以替换它。**时间戳满足第一条，不满足第二条** —— 时钟回拨会倒向索引。
Python 侧只校验 `mutationToken > 0`，不会替我们发现换源。

（相关但无碍：`lockDueJobs` 用 `ORDER BY id` 却按 `status` 筛选、每秒重扫、
不维护高水位，所以自增空洞导致的「跳过已提交行」那个经典 bug 在这里不存在。）

#### 这条性质是可测的 —— 1b 里补，别只留文档

上面那段一度被写成「对这类的唯一防线是把机制和倒向写清楚」。**那句偏保守，
而且偏得有代价**：它会让下一个人以为只能靠文档，于是不去写用例。

要钉的性质：**id 序与提交序无论朝哪个方向分歧，结果都是删除获胜。**
构造它需要控制两件事，两件都是本仓库已有的手法：

- **提交顺序** —— 两个线程各持自己的 `TransactionTemplate`，`CountDownLatch`
  卡住其中一个。`AiConversationLifecycleIntegrationTest` 就是这个形状
  （内嵌 HttpServer + CountDownLatch 制造「模型响应中」的窗口）。
- **领取时机** —— `RagIndexIntegrationTest` 里本来就是直接调
  `jobService.claimDueJobs(...)`，不靠调度器，所以「此刻只有 B 提交了」这个
  中间状态是可观察的。

用例形状（另一半镜像同理）：

1. 事务 A 插入**删除**作业，不提交（它已拿到较小的 id）
2. 事务 B 插入**索引**作业并提交
3. `claimDueJobs` → 只看到 B → 处理 → 断言索引**通过**（此时还没有 fence 记录）
4. 提交 A → 再 claim → 断言向量**被删掉**

镜像那半：删除 id 大、先提交 → fence 记下 → 后到的索引被判为陈旧丢弃。

**为什么归 1b 而不是继续留在文档里**：1b 让这条性质开始承重（unit 索引路径的
fence 检查是新写的），而它目前的依据只有推理。这一整轮反复证明的就是
**并发性质的纯推理依据是最容易错的那一类** —— 包括本节这两个乱序推演本身。

**② `contentHash` 用投影行的 `canonical_hash`。**
换成别的算法就又多一处「同一份内容两个哈希」—— 与当初把 `pageStateHash` 和
`CanonicalText` 对齐是同一个理由。

**③ `finalBatch` 需要多批次夹具才验得到。**
`finalBatch: bool` 必填无默认，所以不会忘记传。危险在于**每一批都传 `false`
是合法载荷**，pydantic 照过，而 `_finalize_source` 只在它为真时跑。
后果是 Stage D 修掉的那条泄漏原样回来（上次索引留下的向量永不清理、
继续参与检索命中），外加 `finish_operation` 永不调用、operation 一直挂着。

要钉的性质不是「字段在」，是「**最后一批必须为 true**」——
**单批次用例恒绿**，怎么写都测不出来。夹具必须让 chunk 数超过
`RagIndexWorker.PARENT_CHUNKS_PER_BATCH`，断言最后一批 true、前面几批 false。

**④ `scopeId` 为空时 payload 里整个不写这个键，不能传 null。**
Chroma 的 metadata 不接受 None。由此推出的契约：SCOPE 删除要求非空 scopeId
（`enqueueDeleteScope` 已就地拒绝空值）。

### 顺带做的类型化

`RagIndexJobService.enqueue(...)` 收 `RagOperation` 而不是 `String`。
做完**必须验证编译器真的接住了** —— 扰动是「传一个字符串字面量进去，编译必须失败」。
（Stage E-1a 的教训：曾声称枚举 switch 漏常量会编译失败，实测 COMPILE-OK ——
Java 只对 switch **表达式**做穷尽性检查，语句不做。）

**它验的是「取值范围」，不是「可达性」。**
`RagOperationCoverageTest` 必须保留：类型化之后照样可以加一个 `RagOperation.FOO`、
被编译器逼着写好消费端分支、然后从不调用 `enqueue(FOO, ...)` ——
而那正是 `DELETE_SCOPE` 与 `DELETE_INDEX_VERSION` 的形状。
类型化收窄的是词表的取值范围，不是词表被用到的程度。

## 1c：检索侧，**与「三处收敛」合并成一步**

- `RagRetriever` 的 payload 换 `namespaces` + `unitIds`
- `rag_source_index_state` 写 `unit_id`
- 三处收敛：门禁分母读投影表、`bySource` → `byUnit`、`sourceCount` 放宽

**必须合并，不能分两步。** 1c 一落地就会写出 `source_id` 为 NULL 的 state 行，
而收敛之前 `bySource.put(state.getSourceId(), state)` 仍在生效 ——
HashMap 允许一个 null 键，存量行会全塌成一个条目、互相覆盖且不报错。
分两步的话，中间窗口只靠「`app.rag.enabled` 最后翻」这个**顺序约定**保护，
而顺序约定可以被下一个人改。合并之后窗口根本不存在。
（同一个动作：fence key 从「两份实现保持最小以免分叉」改成「共享构造器」。）

## `app.rag.enabled` 翻 true 放最后

两个理由：

1. 在它之前，系统的「不可工作」是确定且可解释的；翻了之后任何残余问题都以
   运行时故障出现，而那时正好失去「现在应该是坏的」这个基准。
2. **它是第 1–3 步的保护**，不只是诊断便利。将来谁想为了图方便把它提前，
   这条才是不能提的硬理由。

## 环境

- Docker 已起；**演练容器需重建**，命令在 `deploy/drill/README.md`
- 演练脚本本身踩过六个坑，逐条记在同一份 README（第 5、6 条尤其值得读）
- Python 侧用 `rag-service/.venv`（3.11.9）：
  `.venv/Scripts/python.exe -m pytest tests/ -q`
- Java 侧改公开签名后必须 `mvn -o clean test`，不能 `mvn -o test`
