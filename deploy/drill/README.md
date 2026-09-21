# 回滚演练 runbook

方案 §8.1 / §8.2 的可执行版本。**每次跨越一个不可逆点之前跑一遍**（1B-1 → 1B-2 是第一次）。

## 第 0 步：旧 JAR 能不能启动（实测结论，与最初预判相反）

**最初的预判是错的，写在这里因为它很自然、下一个人多半也会这么推。**
预判是：旧 JAR 的 classpath 里没有新迁移，`validateOnMigrate` 默认 `true`，
于是报 *Detected applied migration not resolved locally* 而起不来。

**实测（1B-1 → 1A，库在 V30、代码在 V28）：旧 JAR 正常启动。**

```
DbValidate : Successfully validated 30 migrations
DbMigrate  : Current version of schema `zhiqu_drill`: 30
DbMigrate  : WARN  Schema has a version (30) that is newer than the latest available migration (28) !
DbMigrate  : is up to date. No migration necessary.
```

机制：`missing` 指版本号落在本地范围**之内**却找不到文件；而回滚产出的迁移版本号
**高于**本地上限，那是 `future`，且 `*:future` 在 Flyway 9+ 的 `ignoreMigrationPatterns`
里**本来就是默认值**。所以预置 `"*:missing"` 是**治别的病的药** —— 属性名对，处方错。

`ignore-migration-patterns` 的正确定位：将来真出现 missing 场景（**删过迁移文件**）才需要，
不是回滚的常规准备。

### 真正的发现：回滚是静默的

原来的预期是响亮的失败 —— 起不来、报错、人知道发生了什么。实测是一条 WARN，然后一切照常。
**这两者的安全方向相反**：响亮的失败是安全的，静默的成功不是。

数据库比代码新的时候，系统不会拒绝启动，只会带着一部分它不认识的 schema 继续跑。
回滚的安全性因此完全建立在一条纪律上，而**没有任何东西在执行它**：

> **迁移只做放宽，不做收紧。**
>
> 任何收紧型迁移（删列、缩类型、加非空、加唯一键）必须**显式论证旧代码在其下仍能正确写入**；
> 论证不出来，就不能与「可回滚」同时成立。
>
> 本仓库已有正反两例：
> - V29 `MODIFY source_id BIGINT NULL`、V30 `MODIFY dedupe_key ... NULL` —— NOT NULL → NULL，
>   放宽，回滚天然安全。
> - V29 的 `CREATE UNIQUE INDEX uk_rag_source_state_unit` 是**收紧**，本来危险；
>   它安全是因为旧 JAR 永远写 `unit_id = NULL`，而 MySQL 唯一键允许多个 NULL ——
>   V29 的注释把这条叫「回滚生命线」，那是**刻意让收紧变得可回滚**。
>
> 规则已经被遵守过一次，但以个案形式。演练证明没有兜底，故升格为通则。

### 机器可检的判据

**不要 grep 日志文本** —— 那句 WARN 的措辞会随 Flyway 版本变。跨版本稳定的等价判据是：

1. 旧 JAR **起得来**（进程存活 / 健康检查通过）；
2. `flyway_schema_history` 的**行数未变**（旧 JAR 不该写入任何迁移记录）。

## 环境

三件，不是两件：JAR + MySQL + Redis。

```bash
docker run -d --name zhiqu-drill-mysql -e MYSQL_ROOT_PASSWORD=drill -e MYSQL_DATABASE=zhiqu_drill -p 13306:3306 mysql:8.0.36 --character-set-server=utf8mb4 --collation-server=utf8mb4_general_ci
```

```bash
docker run -d --name zhiqu-drill-redis -p 16379:6379 redis:7-alpine
```

MySQL 版本与 Testcontainers 里保持一致（`mysql:8.0.36`），否则演练顺带引入了一个
没人打算引入的变量。

**绝不指向开发库 `zhiqu_db`**：演练会把 history 推到 V30，而 V29 的
`ALTER TABLE ... ADD COLUMN` 与 `CREATE UNIQUE INDEX` 在 MySQL 里都**没有**
`IF NOT EXISTS`（同文件里的两个 `CREATE TABLE IF NOT EXISTS` 有，这两句没有）。
删掉历史行后重跑必然撞重复列/重复索引 —— 库会进入「schema 与 history 互相矛盾、
且靠删行修不回来」的状态，只能手工写 DDL 撤 V29。
演练要验的就是 Flyway 历史，拿开发库当实验台等于在被测对象上做实验。
（V30 本身可重入：`MODIFY` 与那条 `UPDATE` 都幂等。但一条不行就够了。）

## 回滚目标的构建

当前树全程不动，用 worktree 取旧构建 —— 直接 `git checkout` 会留下未跟踪的新文件，
得到的既不是旧版也不是新版；`git stash -u` 能清干净但那是最容易丢工作的一条路。

```bash
git worktree add ../zhiqu-rollback-target 98ba5ef
```

## 控制变量

新旧两次启动**共用** `deploy/drill/application-drill.yml`：`app.crypto.master-key`、
`jwt.secret`、Redis、端口全部固定。逐项理由写在那个文件的注释里 ——
密钥漂了会让解密失败被读成「回滚导致数据不可用」，而它和回滚毫无关系。

## 四步（缺一不可）

| 步 | 动作 | 判据 |
|---|---|---|
| 0 | 新 JAR 起一次（迁到 V30），停掉，起旧 JAR | 旧 JAR **能启动**（实测如此），且 `flyway_schema_history` 行数未变 |
| 1 | **回滚期间制造数据变更** | 新建/编辑/删除若干 Wiki 页与资料 |
| 2 | 停旧 JAR，起新 JAR | 启动正常 |
| 3 | 触发一次全量 `reconcileAll` | 投影追上第 1 步的**全部**变更 |

第 1 步最容易被跳过，而它正是演练的实质：回滚期间 Wiki 钩子不存在，用户照常编辑，
**投影表静默变旧** —— 没有任何报错，因为那时根本没有代码在看它。

第 3 步的 `reconcileAll` 不是可选项：缺了它，索引会安静地停在回滚开始的那一刻，
而每一处代码单看都正常。**滚回流程里必须包含它。**

> **该阻塞项由演练发现并已修复。** 记在这里因为它说明了演练的价值不在「验证已知」：
> 当时 `RagUnitRegistry.reconcileAll()` **零生产调用方** —— 只有定义与两处 Javadoc 引用，
> 没有 `RECONCILE_UNITS` 作业、没有管理端点，第 3 步物理上无法执行。
> 四个声明的作业类型里只实现了两个，而**两个洞互相盖住了对方**：单看代码每处都正常。
> 现已补齐 `RECONCILE_UNITS`（worker 分支 + `POST /api/admin/rag/reconcile-units`）。
>
> 顺带修掉的第二个洞：`app.rag.enabled=false` 时 worker 曾在 `run()` 开头
> `if (!client.configured()) return;`，于是对账作业永远停在 PENDING —— 而对账**不发
> sidecar 请求**，它没有理由被 sidecar 的可用性挡住。改为在 SQL 领取谓词里
> **只豁免 `RECONCILE_UNITS`**（`AND (#{sidecarAvailable} = true OR operation = 'RECONCILE_UNITS')`）。
> 代价是 `app.rag.enabled=false` 的部署会每秒空转一次领取查询 —— 已知且接受，
> **不要把那个早返回加回来**，理由写在 `RagIndexWorker.run()` 的注释里。

第 1 步造的数据要覆盖**两类**，只造一类会漏掉另一条路径：
- **新增 Wiki 页** → 投影里根本没有这一行，走 `ensureRow` 建行；
- **编辑已有页** → 投影里有行但内容旧了，走 `applyContent` 比哈希。

第 1 步的判据要写成**增量**而不是绝对值：准备阶段建基线页本身就会经 Wiki 钩子入一条
`UPSERT_UNIT`，所以「回滚期间入队的作业数为 0」永远不成立。要断言的性质是
「回滚期间**没有新增**」，必须取回滚前的基数再比 —— 又一个「判据的定义域比性质宽」的实例，
而它此前一直没被发现，因为那行输出从来没人对着预期读过。

## 实测结果（2026-08-08，1B-1 → 1A）

> **⚠ 有效性：第 3 步的结果对当前代码已不成立。**
>
> 它走的 `reconcileAll` 与索引路径在 1B-2 的 Stage D / E 全部重写过
> （sidecar 契约换 unit 方言、索引记账重做、代次展开改读投影表）。
> **E-4 完成后需要重跑并重新记录**，那也是建立新契约下可回滚基线的窗口
> （理由见 `docs/rag-1b2-stage-e-handoff.md`）。
>
> 上面那个日期只说明<b>出处</b>，说明不了<b>有效性</b> —— Stage D 也在同一天前后落地，
> 单看日期分不出这次演练在契约改动之前还是之后。
> **结果表比注释更容易被当成现状读**，因为它长得像状态而不像观察，
> 所以有效性要显式写出来，不能靠读者自己去比对时间线。

| 步 | 判据 | 主干 | 扰动（跳过第 3 步对账） |
|---|---|---|---|
| 0 | 旧 JAR 起得来 + `flyway_schema_history` 行数不变 | 成功，30 → 30 ✓ | 同 |
| 1 | 回滚期间**新增**作业数为 0 | 1 → 1 ✓ | 同 |
| 1 | 新增页此刻投影行数为 0 | 0 ✓ | 同 |
| 2 | 滚回新 JAR 启动正常 | 成功 ✓ | 同 |
| 3 ① | 新增页已建投影行（`ensureRow`） | **1 ✓** | **0 ✗** |
| 3 ② | 已有页哈希已更新（`applyContent`） | **`bfa69b…` → `fc3b8d…` 变了 ✓** | **未变 ✗** |

**扰动恰好一次，因为本演练只声称钉住一条性质**：滚回流程必须包含一次 `reconcileAll`。
跳过它之后 ①② 双双转红 —— 演练对该性质是敏感的，不是空跑。
扰动开关留在脚本里，可重跑：

```bash
DRILL_SKIP_RECONCILE=1 bash deploy/drill/drill.sh
```

## 演练脚本自身的坑（Git Bash / Windows）

第一次跑完整演练时红了五次，**五次全在脚本，零次在被测代码**。这个比例本身是个结论：
一个不自证的演练脚本会把自己的缺陷伪装成被测对象的缺陷。逐条记下来，别再踩。

| # | 现象 | 真因 | 修法 |
|---|---|---|---|
| 1 | Java 认不出配置文件路径 | Git Bash 的 `/c/...` 不是 Windows 路径 | `cygpath -m` |
| 2 | 第二次启动撞「Port 18080 already in use」，**读起来像「新 JAR 起不来」** | `$!` 是 Git Bash 的 PID，不是 Windows 侧 `java.exe` 的 | 按端口杀（`Get-NetTCPConnection`） |
| 3 | 第 3 步报「投影没追上」 | **建页 API 早就失败了**，响应全进了 `/dev/null`，根本没有数据被造出来 | `apiOk`：每个业务调用自证 200，否则当场中止 |
| 4 | `Invalid UTF-8 start byte 0xbb` | Git Bash 把中文 JSON 体按 GBK 传出 | 载荷一律 ASCII —— 对照实验不该顺带引入编码变量 |
| 5 | Tomcat HTML 400，**与登录毫无关系的样子** | 四处 sed 里有一处存的是**裸 0x01 控制字节**而不是 `\1`（编辑器不可见，`grep '\\1'` 也搜不到）→ TOKEN=`"\x01"` → `Authorization: Bearer \x01` 被 Tomcat 在进 Spring 之前拒掉 | 收成单个 `login()`，且校验 **JWT 形状**而非「非空」 |
| 6 | `SELECT id ... WHERE title='baseline-page'` 抽到 `"1\n2"` | 演练库**不在每轮之间清空**（清空会破坏第 0 步要验的 flyway 历史），而每轮新注册一个用户、建同名页 —— 查询没按用户限定就跨轮取到多行 | 一次取出 `DRILL_UID`，此后**每一条 SQL 都带 `user_id=$DRILL_UID`** |

第 5 条有两层，第二层才是要点：

- **表层**：shell 桥接会吃掉反斜杠，把 `\1` 变成它的控制字符。本仓库此前在
  `CanonicalTextCharacterizationTest` 里混进裸 U+001E 是同一物种。
  写这类脚本时不要用 heredoc 传含反斜杠的 sed 表达式。
- **深层**：那三处「正确」的抽取都带着 `[ -n "$TOKEN" ] ||` 守卫，**而这个守卫救不了它** ——
  `"\x01"` 非空。非空判据的定义域比它声称报告的性质窄：它只认得「什么都没抽到」，
  认不得「抽到了垃圾」。所以修法不是「给第四处补上守卫」，是**把判据换成形状校验**
  （JWT 字符集 `[A-Za-z0-9._-]` + 恰两个点），顺便才把四处收成一处。

第 6 条同样有第二层，而且比第 5 条更值得记：**它在被逮住之前已经悄悄错了好几轮。**
`BASE_HASH` 也是同一条无限定查询取的，两轮内容相同则两行哈希相同 ——
肉眼看不出它是个多行字符串，而末尾判据 `[ "$BASE_HASH" != "$NEW_HASH" ]` 一直在拿多行值
做比较。它没报错，只是**碰巧还没错到能被看见**。真正逮住它的不是这条判据，是第 5 条修法
顺手加的 `case "$PID" in *[!0-9]*)` 形状校验 —— 形状校验会在垃圾产生的**那一步**喊，
而不是等它传到几步之外变成一个别的现象。

另一处同类的口径错误：第 1 步原本断言「回滚期间入队的 RAG 作业数**为 0**」，
但准备阶段建基线页本身就会经 Wiki 钩子入一条 `UPSERT_UNIT` —— 总数从来不是 0。
要断言的性质是「回滚期间**没有新增**」，所以必须取回滚前的基数再比。
判据写成绝对值而不是增量，是「定义域比性质宽」的又一个实例。

一条通用规则，脚本里所有中间步骤都适用：

> **凡是「从输出里抠一个值出来」的步骤，都要自证抠到的是它该有的形状。**
> `apiOk` 让每个 API 调用自证成功，但 token 抽取、`SELECT id` 取主键这类
> **不是 API 调用的中间步骤**同样会静默产出垃圾，且失败会在很远的地方以别的面貌冒出来。

还有一个 shell 层面的陷阱，写 `login()` 时差点踩：**`TOKEN=$(login ...)` 里的 `exit 1`
只退出命令替换的子 shell**，守卫会照常打印却拦不住脚本 —— 那就退回成「打印一行没人看的
警告，然后继续用坏值」。所以 `login()` 写全局变量，不走 stdout。

## 清理

```bash
docker rm -f zhiqu-drill-mysql zhiqu-drill-redis
```

```bash
git worktree remove ../zhiqu-rollback-target
```
