# E-4：首次启用语义检索（RAG cutover）

把 `app.rag.enabled` 从 `false` 翻成 `true` 的那一次操作。**全程在服务器上做。**

与 `README.md` §13-2 的区别：那一节是**协议切换**（sidecar 请求格式不兼容变更，需要停机原子替换），
本节是**首次启用**——系统此前一直跑关键词检索，向量侧从未上线过。两者步骤不同，不要混用。

> 顺序不是排期，是被机制强制的。想跳步的话，跳过会在启用那一刻响亮失败，
> 而不是安静地上线一个残缺索引 —— 见文末「为什么这个顺序不靠纪律」。

## 术语

| 名字 | 是什么 | 怎么改 |
|---|---|---|
| `app.rag.enabled` | `application-prod.yml` 里的配置 | **改完必须重启后端** |
| `rag.worker-mode` | 运行时开关，存 `app_runtime_flag` 表 | 管理接口，**不重启**，有 5 秒本地缓存 |
| `rag.producer-frozen` | 同上 | 本次用不到（那是协议切换用的） |
| `rag.wiki-scope-max` | 同上，Wiki 检索范围的页数上界，默认 200 | 管理接口，**不重启** |

下文 `<域名>` 与 `<管理员token>` 自行替换。

## 前置检查

1. **先备份**（`BACKUP.md`）。这次操作会写投影表、建向量代次。
2. sidecar 已按 `README.md` §6 装好并起着：

```powershell
curl.exe http://127.0.0.1:8001/v1/meta
```

   要看到 `ready: true`，且 `indexVersion` 与 `application-prod.yml` 的 `app.rag.index-version` 一致。

3. **`app.rag.service-token` 两侧必须是同一个随机串**（后端配置 与 `rag-service\.env`）。
   忘配 token 的症状现在与「压根没开」是可区分的：`GET /api/admin/rag/status` 的 reason
   会是 `TOKEN_MISSING` 而不是 `DISABLED`。这两个此前是一个合并的字符串，
   而 E-4 正是最需要区分它们的那一步。

## 第 1 步：先把 worker 停掉（**在翻开关之前**）

```powershell
curl.exe -X PUT "https://<域名>/api/admin/runtime-flags/rag.worker-mode" -H "Authorization: Bearer <管理员token>" -H "Content-Type: application/json" -d "{\"value\":\"OFF\"}"
```

**等至少 10 秒**再往下走：开关有 5 秒本地缓存。

这一步让「翻开关」与「开始干活」成为两个可观察事件。合成一步的话，出问题时只能翻回
`app.rag.enabled`，而那会连带影响检索侧。

## 第 2 步：翻 `app.rag.enabled=true` 并重启后端

改 `application-prod.yml`，然后 `Restart-Service zhiqu-backend`。

**此刻应当什么都没有发生**，确认这三件事：

- worker 一条作业都不领（`rag.worker-mode=OFF`）；
- 检索虽然「上线」了，但**没有 ACTIVE 代次** ⇒ 回落原因 `NO_ACTIVE_GENERATION` ⇒ 走关键词，
  **检索行为与昨天完全一致**。

```powershell
curl.exe "https://<域名>/api/admin/rag/status" -H "Authorization: Bearer <管理员token>"
```

在返回里核对：

| 字段 | 期望 |
|---|---|
| `enabled` | `true` |
| `sidecar.ready` | `true`（若为 false，看 `sidecar.reason`：`TOKEN_MISSING` 是配置错，`DISABLED` 说明开关没生效） |
| `activeGeneration` | **空** —— 这就是「检索行为不会变」的保证 |
| `jobs.PENDING` | 积压数，此刻不动（worker 是 OFF） |

随后发一次对话，再看一次 `metrics.fallbacks`：`NO_ACTIVE_GENERATION` 那一项应当在涨。
它涨说明向量路径确实被走到了、并且按预期回落——比「什么都没发生」信息量大。

顺带留意有没有**别的**东西因为 `client.configured()` 变成 true 而改变了行为。
这是本步唯一要靠眼睛看的事，后面几步都有机制兜底。

## 第 3 步：放开 worker，排空积压

```powershell
curl.exe -X PUT "https://<域名>/api/admin/runtime-flags/rag.worker-mode" -H "Authorization: Bearer <管理员token>" -H "Content-Type: application/json" -d "{\"value\":\"NORMAL\"}"
```

积压是**自 E-1a 起累积**的 `UPSERT_UNIT`。每条要解密 → 清洗 → 切片 → 过 bge 嵌入 → 发给 sidecar，
而同一台机器还在服务用户；除 `workerBatchSize` 与 1 秒轮询之外**没有任何节流**。
（积压有界：`dedupe_key` 到终态才释放，所以是每页一条，不是每次编辑一条。）

盯着排空：

```powershell
curl.exe "https://<域名>/api/admin/rag/status" -H "Authorization: Bearer <管理员token>"
```

看 `jobs.PENDING`、`jobs.RUNNING`、`jobLagSeconds` 到 0。

**出问题就退回 `rag.worker-mode=OFF`**，不要翻回 `app.rag.enabled`。

## 第 4 步：全量对账

```powershell
curl.exe -X POST "https://<域名>/api/admin/rag/reconcile-units" -H "Authorization: Bearer <管理员token>"
```

**这个接口只入队、不内联执行**（对账要解密全部用户的全部 Wiki 页，放在 HTTP 请求里会占着连接
跑几分钟且没有重试语义）。返回「已入队全量对账作业」之后，仍要按第 3 步的方式等队列排空。

投影表由这一步填上。**第 6 步的守卫强制它必须先做。**

## 第 5 步：建代次

```powershell
curl.exe -X POST "https://<域名>/api/admin/rag/rebuild" -H "Authorization: Bearer <管理员token>"
```

等代次从 `BUILDING` 变 `READY`，记下代次 id。

## 第 6 步：启用代次 —— **检索行为真正改变的点在这里**

```powershell
curl.exe -X POST "https://<域名>/api/admin/rag/generations/<代次id>/activate" -H "Authorization: Bearer <管理员token>"
```

两道门禁会挡住残缺上线，被拒绝时按提示回上一步，**不要绕过**：

| 报错 | 含义 | 回到 |
|---|---|---|
| `当前仍有 N 个语料单元未完成该代索引，不能启用` | 覆盖率不足 | 第 3 / 5 步，等排空 |
| `语料投影表为空但库里存在可索引内容 —— 请先在管理端触发一次「全量对账」` | 空分母闸门 | 第 4 步 |

第二条尤其要紧：没有它的话，投影表是空的 ⇒ `missing == 0` ⇒ 门禁会放行一个**一条向量都没有**
的代次，而每一层都显示成功。

启用之后再发一次对话，回到 `/api/admin/rag/status` 核对：

- `activeGeneration` 不再为空；
- `metrics.fallbacks` 里 `NO_ACTIVE_GENERATION` **停止增长**；
- `metrics.candidatesReturned` / `candidatesHydrated` / `candidatesFinal` 开始有数
  —— 三个一起看：`returned` 有数而 `hydrated` 为 0 意味着候选全被回填丢弃，
  那会静默退回关键词，只是这次原因不同（`metrics.droppedCandidates` 按原因分了桶）。

## 第 7 步：量排名分布，给 `rag.wiki-scope-max` 一个依据

**现在的 200 是暂定值，没有依据。**

要量的是：**命中的 top-24 候选，在「按 `updated_at` 倒序」里的排名分布。**
不要去量延迟 vs N 的曲线 —— 它对 N 单调上升，读不出门槛，量完还是拍脑袋。

- 若命中几乎从不来自第 50 名之后的页 → N=200 安全，N=50 也安全；
- 若经常来自第 300 名 → 200 正在静默砍掉有用的东西。

同时量两处随页数线性增长、**至今一次都没量过**的东西：

1. `payload.unitIds` 的基数（几百页就是几百个 id 进一个 JSON 请求体，sidecar 侧是 Chroma 的 `$in` 大列表）；
2. `freshlyIndexedUnits` 的 `IN (...)` 状态查询。

`/api/admin/rag/status` 的 `metrics` 里现成有两个观测点：

| 字段 | 读法 |
|---|---|
| `wikiScopeTruncations` | 上界被触发的**次数** |
| `wikiScopeMaxSeenUnits` | 见过的**最大**语料量 —— 只有次数的话，「截自 205」与「截自 5000」不可分 |

两个一起看：`truncations` 长期为 0 说明 200 根本没夹到人，此时收紧到 50 才有意义；
`maxSeenUnits` 远大于 200 说明确实有重度用户，那就先别动上界，去量排名分布。

**这一项只能在启用代次之后取**（那时才有真实的 top-24），所以它是 E-4 的最后一步，
不能和翻开关并发做。E-4 也是唯一有真实语料的时刻。

收紧不需要重启：

```powershell
curl.exe -X PUT "https://<域名>/api/admin/runtime-flags/rag.wiki-scope-max" -H "Authorization: Bearer <管理员token>" -H "Content-Type: application/json" -d "{\"value\":\"50\"}"
```

> 为什么上界按**页数**而不是 chunk 数：token 成本已被 `min(max_candidate_k, candidateK)` 与
> `finalK / maxContextChars / maxPerSource` 夹死，与范围大小无关；真正无界的是 id 基数，
> 它按单元个数增长。按 chunk 给预算在巨页上是反的——500 chunk 的页在 id 基数上只值 1，
> 却会独占 chunk 预算把其余几百页挤出去。**页数上界抗巨页，chunk 预算怕巨页。**

## 第 8 步：立刻建立 Phase 2 的可回滚基线

**这一步不能推到以后。**

跑过的那次回滚演练验的是 1B-1 → 1B-2 之间的回滚，而它第 3 步（对账追上）走的代码此后已被重写——
**那份演练结果对当前代码是过期的**。Phase 2 开工需要一个新契约下的已知可回滚基线，现在没有。

最佳时刻正是 E-4 刚完成这一刻：系统可工作、契约稳定、演练脚本与容器都已调通。
错过这个窗口，就要在一棵已经变动的树上重建基线。

1. 重建演练容器并重跑四步演练——命令在 `deploy/drill/README.md`，
   **动手前先读那份 README 的第 5、6 条坑**（演练脚本自身踩过六个）；
2. 四步全绿后打一个新 tag。

## 回退

| 走到哪一步出问题 | 怎么退 |
|---|---|
| 第 3 步之后 | `rag.worker-mode=OFF`。**不要**翻 `app.rag.enabled` |
| 第 6 步之前 | 检索行为一直没变过（无 ACTIVE 代次），`app.rag.enabled` 翻回 false 并重启即可 |
| 第 6 步之后 | 上一代次 24 小时内仍是 `RETIRED` 而未被清理，可重新启用它 |

## 为什么这个顺序不靠纪律

| 动作 | 发生什么 | 谁在保护 |
|---|---|---|
| 翻 `app.rag.enabled` | worker 开始领积压的 `UPSERT_UNIT`；检索也「上线」 | 无 ACTIVE 代次 ⇒ `NO_ACTIVE_GENERATION` ⇒ 关键词回落，**检索行为不变** |
| 全量对账 | 投影表填上 | `RagAdminService.validateCurrentReadyCoverage` 的空分母闸门强制它必须先做 |
| 建代次 + 启用 | **检索行为真的改变** | 覆盖门禁：全部单元索引完才放行 |

**检索行为的改变点不是翻开关，是启用代次。**「部分索引的向量检索静默上线」这条路被堵住了。

写成 runbook 步骤是纪律，可以被跳过；那个守卫让跳过在启用那一刻响亮失败 ——
**它是这个顺序的唯一执行机制**，不要为了图方便去绕过它。
