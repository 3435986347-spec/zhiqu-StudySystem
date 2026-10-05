# 测试：判据的纪律与那些故事

> 原来是 `CLAUDE.md` 里的「Tests」，第三十八轮（方案第 5 步，`CLAUDE.md` 瘦身）原样挪到这里，一字未改。
> `CLAUDE.md` 现在只留规矩；这里是来龙去脉和细节。文中「上面」「下面」指的是原来 `CLAUDE.md` 里的位置。

### Tests

```bash
cd zhiqu-backend
mvn -o test                      # offline; the first online run must fetch junit-platform-launcher
mvn -o test -Dtest=WikiToolGuardTest
```

**After changing any public constructor or method signature, run `mvn -o clean test` — not
`mvn -o test` or `test-compile`.** Incremental compilation does not recompile unchanged callers,
so a test whose source still calls the old signature keeps its stale `.class` and the build reports
success. The mismatch only surfaces at runtime as `NoSuchMethodError`, which reads like a
dependency problem rather than what it is.

Integration tests use an in-process stand-in for Redis (`src/test/resources/application.properties` points it at port 1) —
never the developer's own `localhost:6379`; see round 13. The same file turns scheduled jobs off (`app.scheduling.enabled=false`,
round 14 — `spring.task.scheduling.enabled` is not a Spring Boot property and did nothing). Integration tests need Docker (Testcontainers). Without it they skip silently — `Tests run: N,
Skipped: N` is not a pass. Use `-Dzhiqu.skipDockerTests=true` to make the skip explicit.

**A new assertion does not count until it has been seen red.** A green can mean *the judgment
looked and found nothing wrong*, or *the judgment could not see anything at all* — the two are
indistinguishable in the code. Three of the latter turned up on 2026-09-03 alone: an explanatory
comment inside `route()` satisfied the `contains("ZQUI.isAdminPage(")` that was meant to detect
that very call being deleted; a commented-out line in the `SecurityConfig` whitelist satisfied
the check that the page was whitelisted; and a regex that no longer matched anything left an
empty set, over which every later assertion passed vacuously. `contains` cannot tell *the code
does this* from *the text mentions this*, and an empty scan is shaped exactly like a clean one.
Two habits follow: strip comments before asserting over source (`AdminPageWiringTest.stripComments`,
shared by both of its judgments), and assert a floor on how much the scan actually saw
(`StaticAssetCacheTokenTest`, `AdminPageWiringTest.后台页集合解析不能扫空`). Neither is a
substitute for perturbing the source and watching the new assertion fail — that is the only step
that tells the two greens apart, and all three cases above were caught by it rather than by review.

**And verify the perturbation itself took effect.** On 2026-09-20 a perturbation script reported
a clean green for the `status = 'STREAMING'` guard in `AiMessageMapper.flushStreamingContent`.
The guard was fine; the *perturbation* never ran — inside a quoted heredoc the `perl -0pi ... \$F`
argument stayed literal, perl could not open a file called `$F`, and it **exited 0**, so the
`|| fallback` never fired and the unmodified source was tested. A perturbation that silently
does nothing produces a green shaped exactly like a judgment that is too weak to notice.
So assert on the perturbed source before running it (`grep -c` the removed condition and refuse
to continue unless it is 0), and never chain `grep -c` with `&&` — it exits 1 on a count of zero
and will break the chain you meant to guard.

**Keep perturbation backups outside `src/`.** Maven copies everything under `src/main/resources/static/` into `target/classes`,
so a `zhiqu-api.js.perturb-bak` left next to the source during a test run lands in `target/classes` — and a JAR packaged without
`clean` would ship it (2026-10-03).

**And restore with a fresh mtime.** On 2026-09-23 a perturbation batch restored files with
`cp -p` (to keep an executable bit) — which also restores the file's *old modification time*.
Maven's incremental compile then judges the source older than its `.class` and keeps the
**previous perturbation's class**. Runs that only perturbed JS or shell never triggered a Java
recompile, so one perturbation's residue showed up as an extra red in seven later runs, and the
last one's residue was still sitting in `target/` afterwards. Restore with plain `cp` (it keeps
the destination's mode) followed by `touch`, and `clean` before the full run. Two more from the
same day: the shell here is **zsh**, where `for f in $FILES` and `set -- $pair` do **not**
word-split — use arrays or explicit arguments; and an experiment whose control group does not
fail tells you nothing (`kill(pid, 0)` reports zombies as alive — see 命令行 `zhiqu`).

**前端行为判据跑在 node 上，而不是在 Java 里重写一份。** `CodeHighlightEscapeTest` 调用
`src/test/resources/js/highlight-check.js`，后者直接加载 `assets/zhiqu-api.js` 里发布的那份
实现来喂对抗性输入。重写一份 Java 版就成了「测试一个副本」—— 副本绿了不代表线上那份对，
而且两边迟早分叉。没有 node 的机器上它**显式失败并说明原因**，node 装在非标准位置用 `-Dzhiqu.nodePath=<绝对路径>` 指过去；确实没有 node 又要构建，
要跳过得写明 `-Dzhiqu.skipNodeTests=true`，和 Docker 那批的 `-Dzhiqu.skipDockerTests=true`
同一个约定。

**node 把超过自己 `{ timeout }` 的测试记成 `cancelled`，不是 `fail`**（TAP 汇总 `fail 0 / cancelled 1`，
退出码 1）。2026-09-24 一次全量里 `HarnessCliNodeSuiteTest` 挂了 999 秒、只留下「cancelled 1」，
日志在临时目录里、已经被清掉，是哪一条再也查不到。所以 `NodeRunner` 现在把没过的（失败 + 被取消）
连同 `error:` / `location:` 点名放在报错**最前面**；输出写临时文件、`waitFor` 等进程本身 ——
原来先 `readAllBytes()` 读到 EOF，而测试漏掉的孙子进程会攥着管道写端（实测 20 秒定时器让管道晚关 21 秒），
那个 300 秒的超时根本轮不到。`node --test` 自己也会等孙子进程，这段等待消不掉，只能保证有上限。
`NodeRunnerTest` 钉这三件事（外加 stdin 当场给 EOF）。

**扰动还会推翻你写判据时的那个理由。** 2026-09-21：着色器的注释原本写着「先转义再分词会
漏出标签，那是 XSS 的经典写法」。扰动一跑，那个改动只让「字符串不再被识别」红了，标签
一个没漏 —— 因为分词器只切分、从不反转义。真正的洞是完全不转义，由另一条判据抓住。
理由写错了会误导下一个改这段代码的人，所以理由本身也要以扰动结果为准。

**「宁可启动就炸」的守卫，实际上炸在每一次请求里，而且没人接。** `AgentStageExecutor` 是
`streamChatInternal` 里**每次流式请求现造的**，不是启动期造的。它的 `rejectAmbiguousSlots`
（两个 runner 抢同一个 `(位置, 动作)` 槽）和 `MultiAgentOrchestratorImpl.materialize` 的幽灵节点
检查都住在 `beginRun` 之后、跑各相位那个大 `try` 之前的**装配窗口**里。那段窗口原来不设防：
异常逃到 `streamChat` 最外层的 catch，发一条 SSE error 就完事 —— run 永远停在 RUNNING、
日志一行没有、前端那条消息永远停在 STREAMING。2026-09-21 撞了一次（`CODE_AGENT` 的 `runAt`
撞上 `PLAN_EXTRACTOR` 的 `announceAt`），表现是 15 条集成判据一起红、单跑 384 秒、
整份日志里没有一个字的异常。现在装配窗口单独圈了 try（记日志 + `errorRun` + `failAssistantMessage`），
由 `StreamAssemblyFailureGuardTest` 盯着结构，`AgentGraphOrderDerivationTest.真实runner之间不得抢同一个槽位`
把槽位冲突提到编译期这一侧 —— 后者 1 秒给答案，并点名是哪两个 runner。

**加 runner 时记住：不覆写 `announceAt`/`commitAt` 就等于 `runAt`，一个 runner 默认占三个槽。**
挑位置要把这三个都算上。`RealRunOrder` 现在读全三个位置；它原来只读 `runAt`，所以那个真实存在的
冲突在判据眼里根本不存在 —— 一个自称用「真实声明的位置」的 fixture，只读了三分之一。

**对比「是不是我改坏的」时，要控制住位置这个变量。** 用 `git worktree` 开基线检出很方便，
但 worktree 建在 `/private/tmp` 下、而当时的工作区在 iCloud 同步的 `~/Desktop` 下 ——
两次跑同时变了代码和位置。2026-09-21 就这样得出过一个「结论正确但推理不成立」的判断
（基线 17.7 秒 vs 改动 384 秒，其中 330 秒其实是 iCloud 的类路径扫描卡顿）。
仓库已经搬出 iCloud，这个具体诱因没了，但方法仍然成立：**一次只动一个变量**。
基线检出和被测检出要在同一个卷、同一类目录下。
