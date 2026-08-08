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

## 扰动判定分两级（1b 实测得来）

先看**有没有东西红**，再比对红的集合与预期：

> **每次扰动必须让某个东西变红 —— 不必是预期的那个测试。**
> **整套测试全绿时，结论是「被扰动的代码没有被执行」（UNEXERCISED），**
> **不是「测试不敏感」。**

这条严格强于「锚点必须唯一 + 施加前断言 count==1」：唯一但从未被任何测试走到的
锚点照样通过唯一性检查，然后给出同样的假 GREEN；而且它不需要事先知道锚点出现几次。

两个实例都在本仓库：

- `finalBatch` 的扰动锚点在 `RagIndexWorker` 里有**两处逐字相同**
  （legacy 的 `indexSource` 与新的 `indexUnit`），第一次改到了测试不走的那处 ——
  锚点匹配、扰动施加、测试全绿，三个「确实」凑成一句错误结论；
- `DELETE_INDEX_VERSION` 曾是一行谁都没走过的 switch 分支，
  任何对它的扰动都会全绿 —— 这条判据的反面例证。

与「装置坏了当成结论」（容器瞬时故障读成 RED）是镜像的一对：
这条是「装置打偏了当成结论」。两个方向都要在判定里。

## 1c 写入侧：已完成（本轮）

六步里的 1–4 全部落地，并且**比原计划大**——原步序漏算了三处，都是实测撞出来的。

| # | 内容 |
|---|---|
| 1 | `RagSourceIndexState` 加 `unitId`；mapper 加 `lockByUnitAndGeneration` |
| 2 | `upsertUnitState` / `currentIndexedUnitState` / `markUnitIndexedWithLease` |
| 3 | `indexUnit` 累加 sidecar 响应的 `written` 并记账（1b 把响应丢了） |
| 4 | 代次展开、进度核算、启用门禁**三处**统一读投影表（V29 点名的那三处） |

### 原步序漏算的三处

**① 生产端也得换。**`UPSERT_SOURCE` / `REINDEX_SOURCE` 的载荷会被 Stage D 之后的
sidecar 以 422 拒绝。留着它们等于留两个「有消费端、生产端已死」的常量 ——
所以两个枚举常量、`indexSource`、以及整套 LEGACY 索引记账
（`markIndexed` / `markIndexedLocked` / `markIndexError` / `upsertSourceState` /
`currentIndexedState` / `lockBySourceAndGeneration`）一并删除。
`RagOperationCoverageTest` 的下限 9 → 8，改动写在那条用例的注释里。

**② 「投影行不存在」被当成了「删除赢了竞态」。**`refreshUnitIfLive` 原本
`findUnit(...) == null → 让位`，而 `null` 同时覆盖「行被删了」与「行从没建过」。
后者是常态：`upsertNotebookUnit` / `upsertWikiUnit` **零生产调用方**，投影行只由
`RECONCILE_UNITS` 批量建。于是新建一个 Wiki 页 → 入队 `UPSERT_UNIT` → 查不到投影行 →
静默让位、作业照转 COMPLETED，要等下次手动对账才进索引。
现在改为回源表补登记，回源查不到才让位。

**③ 失败路径把 `job.getSourceId()` 当资料主键。**增量作业复用那一列承载 `ref_id`，
所以一条 `WIKI_PAGE#7` 的作业失败时会去查「资料 7」并把它标成 ERROR ——
跨命名空间 id 撞车，正是 V29 引入代理主键要消除的东西。改为按 `(namespace, refId)` 定位。
已由 `wiki单元的作业失败不会误标同号资料` 钉住。**「id 是自增的所以构造不了」是错的** ——
MySQL 接受往 AUTO_INCREMENT 列写明确值，只会把计数器顶上去，两条 INSERT 各指定同一个数字即可。
定位这一步同时提成了 `RagIndexWorker.targetUnitOf`：第一版用例在测试里**复述**了一遍那条判断，
于是改坏 worker 也不会红 —— 判据测的是自己那行复制品。

### 顺带定死的两条

- **`indexUnit` 写进哪些代次**：作业带 `generationId` → 只写那一个（重建不得灌进服役中的旧代次）；
  不带 → 写进当时**所有**在建/在用的代次（否则重建窗口里的一次编辑只落进一个代次）。
- **`operationId` 必须带 `-g<代次>`**：sidecar 按 `(operationId, batchNo)` 幂等，
  每代批号都从 0 重来，不带代次时第二个代次的每一批都会被当成重复批跳过**并返回成功**。

### 门禁的空分母闸门

投影表为空但库里有 READY 资料时，`activate` 直接拒绝并提示先做全量对账。
没有它，`missing == 0` 会放行一个一条向量都没有的代次 ——
「分母为 0 无声放行」是这类覆盖率判据的通用失效形态（方案 §7 点过一次）。
闸门**只在空分母这条路上**回查原始表，不参与覆盖率计算，所以不重新引入口径漂移。

## 1c 检索侧：**未做**（下一轮从这里开始）

- `RagRetriever` 的 payload 仍发 `sourceIds` / `notebookId` —— sidecar 的 `QueryRequest`
  要 `namespaces` + `unitIds`，现在发过去是 422
- `ContextCandidateHydrator` 仍按 `candidate.get("sourceId")` 回填，候选行现在回的是
  `unitId` / `namespace`
- `ScopeSelection` 仍只装 `List<AiNotebookSource>`；`sourceCount` 放宽到全部命名空间
  要等它先能装下别的命名空间，**否则放宽是个空操作**（今天范围里只有 Notebook 资料）
- Wiki 单元的候选回填是新东西：正文加密、不落库，要经 `UnitContentResolver` + 按 code point 切片

**写入侧与读取侧的耦合已经解开**：当初「1c 不能拆」的理由是两侧共用 `state.unitId`
这个尚不存在的字段，那个字段现在存在了。剩下的耦合只在 `ScopeSelection` 内部。

## 本轮的扰动实测

写入侧五条 + 门禁三条，逐条记在两个测试文件末尾。一条值得提到这里：

> 分子从「逐条匹配」改成「数状态行」，**实测 GREEN**。
> 按两级判定那是 UNEXERCISED —— `unitStates` 的 `isNotNull(unit_id)` 把遗留行挡掉了，
> 扰动没走到被测路径。两处一起改才变红。

它推翻了我在同一个用例注释里刚写下的判断（「那句过滤是防御性的、不承重」）：
逐条 `get` 时它确实不承重，换成计数分子后它是唯一挡住遗留行的东西。
**「这行代码有没有用」不能脱离它周围的实现单独判断**，而这类判断读代码纠正不了 ——
读代码得到的恰好就是那个错结论。

## 状态

- Java 178/0/0/0（新增 9 条：记账 4 + 门禁 3 + 跨命名空间撞车 1 + 遗留行过滤 1）
- 删掉 `upsertNotebookUnit` / `upsertWikiUnit`（补登记吸收其职能后只剩测试在调）。
  **删之前先把两条断言迁到 `ensureRow` / `reconcileAll` 上** —— 它们钉的性质仍活着，
  直接删入口会连带删掉活代码的覆盖，而作业词表那套测试看不到这种形状
- 分支 HEAD 仍是**已知不可工作状态**：检索侧未换方言。回滚锚点 tag `1b-1-rollback-verified`
- `app.rag.enabled` 翻 true 依然放在最后（理由见上文）

## 未关闭：归属写错会**销毁数据**（方向已更正）

`requireOwner` 只挡 null，而 null 本来就撞 `rag_indexable_unit.user_id` 的 NOT NULL
（V29:19）—— 响亮，不静默。危险输入是**非空但写错**的 userId。

**先更正一处记错的前提。**此前这里写的是「双条件回读命中 0 行 → UNUSABLE → SKIPPED →
低于门禁 → 代次照常 READY」。查过代码，那条链**走不通**：两个 provider 命中 0 行时
返回的是 `gone(...)`，不是 `unusable(...)`——

```
WikiPageContentProvider.java:38       UnitContent.gone("PAGE_NOT_FOUND_OR_NOT_OWNED")
NotebookSourceContentProvider.java:42 UnitContent.gone("SOURCE_NOT_FOUND_OR_NOT_OWNED")
```

真实形态**比记错的那条更该修**：

```
非空但写错的 user_id
  → 双条件回读命中 0 行
  → GONE → 转 RETIRED
  → 切分边界被删
  → 调用方据 retiredUnitIds 入队 DELETE_UNIT
  → 向量被清理
```

**不是静默漏索引，是把一份健康数据销毁掉**，而每一步单看都是正确行为。

### 要拆的是 GONE，不是 UNUSABLE

那两个 reason 字符串自己承认了合并：`..._NOT_FOUND_OR_NOT_OWNED`。
「不存在」与「存在但不属于我」是两件事 —— 前者该退役，后者是注册缺陷的信号，
实体还在，退役它就是拿删除去响应一个 bug。

**修法：归属不匹配从 GONE 里分出来，成第四种结局 —— 既不退役也不跳过，直接抛，
让作业转 DEAD 并告警。**`UnitContent.Outcome` 加一个常量，两个 provider 各分一次。
（枚举加常量后，`RagUnitRegistry.refresh` 的 switch 是**语句**不是表达式，
编译器不会逼你处理它 —— 见 Stage E-1a 的教训，那里要一并改成表达式。）

按原措辞去做（从 UNUSABLE 里分）改完的不是这个缺陷：判据方向反了，后果也反了。

### 1c 已经做了的那一半

`ensureRow` 对外只剩 `ensureRow(AiNotebookSource)` / `ensureRow(UserKnowledgePage)`
两个重载，收游离 `userId` 的签名转 private（实测：从类外传游离 userId 编译失败）。
已有行的换归属由 `existing.getUserId()` 覆盖；**新建行带非空错值今天没有东西拦**，
靠的是签名让它写不出来 —— 收窄，不是消除。

## 检索侧开工前要先定的一件事：`ContextBudgeter` golden master 的退休

`sourceCount` 放宽会**按设计**改变选取行为（每源配额的触发点从「只数资料」变成
「数所有命名空间」），而那条 golden master 是 1B-1 的验收标准（一行未改且仍绿）。
也就是说它在放宽那一刻失效。

**流程定死：先给新行为写一份新的 golden master（多命名空间下的期望候选集），
两份并存一次，再退休旧的。** 不这么做的话两种错都会发生 ——
守太久（放宽被自己的验收标准挡住），或者悄悄放弃（某天改断言让它变绿，
而那正是这条标准当初要防的动作）。替换要是一次有记录的动作，不是一次断言修改。

## 检索侧的已知坑

Wiki 单元的候选回填是本轮唯一的新东西：正文加密、不落库，要经
`UnitContentResolver` 现取现解密，再按 **code point** 切片
（`offsetByCodePoints` / `RagUnitChunker.sliceByCodePoints`，**不是 `substring`**）。
1b 在索引侧已经踩过一次，检索侧是同一个陷阱的第二个入口。

## 「名字里带 OR」的识别点：已扫，仓库里第二个已修

`..._NOT_FOUND_OR_NOT_OWNED` 暴露出一个可复用的识别点 ——
**标识符里出现 `OR`，而两边本该走不同分支**。扫下来第二个正好在 E-4 会踩的位置：

`DISABLED_OR_TOKEN_MISSING`（旧 `RagClient:42` / `RagRetriever:46`）。
DISABLED 是设计内的正常状态（仓库默认），TOKEN_MISSING 是「开着却不工作」的配置错误。
这个字符串经 `RagClient.meta()` 的 `ready/reason` 进运维可见的健康信息，
而 **E-4 就是把 `app.rag.enabled` 翻成 true** —— 翻完开关却忘配 token 的人，
看到的提示与「你压根没开」一模一样，于是回头去查刚翻过的那个开关。
诊断信号在最需要它的那一步是合并的。已拆成 `DISABLED` / `TOKEN_MISSING`，
且**行为不同**（TOKEN_MISSING 记 fallback 指标，DISABLED 不记）——
只改文案的话随时能被合回去而没有东西会红。

## 拆 `UnitContent.Outcome` 的工作量上界（已扫，清单完整）

加第四个常量后要跟着改的 switch **只有一处**：

| 位置 | 形态 | 处理 |
|---|---|---|
| `RagUnitRegistry.java:460` `switch (content.outcome())` | **语句** | 要改成表达式，否则编译器不拦漏分支 |
| `RagIndexWorker.java:137` `Runnable action = switch (...)` | 表达式 | 已由 E-1a 改过 |
| `RagIndexWorker.java:198` `return switch (...)` | 表达式 | ✓ |
| `AiServiceImpl` 三处 | 一处对 String（穷尽性不适用），两处已是表达式 | ✓ |

## E-4 完成那一刻要做的一件事：建立新契约下的可回滚基线

跑过的那次回滚演练验的是 1B-1 → 1B-2 之间的回滚，而它第 3 步（对账追上）走的代码
此后已被重写 —— **那份演练结果对当前代码是过期的**。

这不是「要能回到 1B-1」的问题（1B-2 的收敛本身不可逆）。真正的问题是
**Phase 2 开工时需要一个新契约下的已知可回滚基线，而现在没有**。

建立它的最佳时刻正是 E-4 刚完成那一刻：系统可工作、契约稳定、演练脚本与容器都已调通
（六次红全在脚本自身上的那批坑都修过了，逐条在 `deploy/drill/README.md`）。
那时重跑一次四步、打一个新 tag，Phase 2 就有了自己的可逆点。
错过这个窗口，等 Phase 2 动起来再补，就要在一棵已经变动的树上重建基线。

## 回落记账已收成结构性的（检索侧开工前的准备）

`RagRetriever` 的每一条非成功返回现在只能经 `fallback(...)` 出去，`disabled()` 是
唯一刻意不记指标的出口；`RetrievalResult.unavailable(...)` 静态工厂已删（它是一条
绕过记账的近路，而且看起来完全无辜）。`RagFallbackAccountingTest` 数绕过的可能性。

**为什么在检索侧之前做**：那批改动会新增返回路径（Wiki 候选回填失败、回填时解密失败……），
每一条都要记，而此前靠的是「写 return 时记得在旁边加一行」——
那条纪律已经失效过一次（sidecar 不可用那条压根没记，是拆合并字符串时偶然发现的）。

不变量的形式：**每条非成功返回恰好记一次回落原因，`DISABLED` 是唯一刻意的例外。**
查过 `retrieve` 的全部返回路径，现在是齐的，没有第二个洞。

## 新 golden master 的预期：**必须是红的**（动手前先声明）

顺序是 新基准先写 → 两份并存 → 退休旧的 → 再动 `sourceCount`。
放宽在最后，所以新基准在并存窗口里**应该红**，「放宽之后转绿」才是证据。
按阳性/阴性对照那条规矩，这个预期<b>先写在这里</b>，避免事后解释。

### 有一个现成的机制会让它假绿

```java
int effectiveSourceCount = Math.max(sourceCount,
        (int) candidates.stream().map(this::sourceKey).distinct().count());
```

`ContextBudgeter:36-37` 这条 `max` 兜底早先就让一次扰动变过绿（把 fixture 的
`sourceCount` 改成 1，`distinct = 2` 照样把配额门撑起来）。同理，一个多命名空间的
期望候选集完全可能在 `sourceCount` 还没放宽时就已被 `distinct` 满足。

**所以第一次跑新基准时，绿不是好消息**，它只有两种解释：
① 期望写错了；② `distinct` 已经替 `sourceCount` 干了活，放宽本身是空操作。
②正是交接单里已经记过的那个风险（放宽要等 `ScopeSelection` 先能装下别的命名空间），
它会以「测试提前变绿」的形式先露头。

### 新基准要拆成三条，各自有明确的转绿点

**不能写成一条。**「Wiki 单元出现在候选集里」需要三件事同时成立：
`ScopeSelection` 装得下别的命名空间、检索按 `unitIds` 查、回填产出 Wiki 候选 ——
而 `sourceCount` 放宽只管每源配额那一层。写成一条的话，并存窗口里它会
**因为多个原因同时红**，而转绿只发生在整条链的最后一步。

一个全有全无的红<b>在多步改动中不携带任何进度信息</b>。更糟的是：走到最后一步还没绿时，
最省力的动作就是调期望值直到它绿 —— 那正是这套替换流程本身要防的动作。

| 断言 | 转绿时机 |
|---|---|
| Wiki 单元出现在候选集里 | 回填打通 |
| 候选按 `unitId` 去重（不再按 `sourceId`） | payload 换 `unitIds` |
| 每源配额按所有命名空间计数 | `sourceCount` 放宽 |

拆开之后每一步都能读出「该动的动了、不该动的没动」。而且第三条单独存在时，
`ContextBudgeter:36-37` 的假绿风险最容易被看见：**前两条已绿而第三条仍红**，
说明放宽确实还没生效；三条一起绿则要回头确认不是 `distinct` 替 `sourceCount` 干了活。
