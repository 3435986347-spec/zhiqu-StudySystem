# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**知趣·象限自主学习系统** — A web-based learning system for college students, built around the
four-quadrant (Eisenhower) method and extended with an AI assistant, a personal Knowledge Wiki,
and optional semantic retrieval (RAG). The frontend is plain HTML/CSS/JS embedded as static files
inside the Spring Boot JAR, so there is **no separate frontend build step**.

## Commands

### Database

The schema is managed by **Flyway** (`zhiqu-backend/src/main/resources/db/migration`, currently
`V1` … `V38`). Migrations run automatically on startup — do **not** apply `schema.sql` by hand.
Only the database itself needs to exist:

```sql
CREATE DATABASE zhiqu_db DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_general_ci;
```

When adding a migration, use the next free `V<n>__description.sql` and keep it additive
(new nullable columns / new tables) so older rows stay valid.

### Run (development)

**macOS / Linux**
```bash
cd zhiqu-backend
mvn clean package -DskipTests
java -jar target/zhiqu-backend-0.0.1-SNAPSHOT.jar
```

**Windows (PowerShell)**
```powershell
cd zhiqu-backend
mvn clean package "-DskipTests"
java -jar target\zhiqu-backend-0.0.1-SNAPSHOT.jar
```

Access at `http://localhost:8080`.

`mvn spring-boot:run` also works. It used to fail with `Could not find or load main class
com.zhiqu.ZhiquApplication` because the path contained CJK characters; the checkout moved on
2026-09-21 and this was re-verified from the new location, not assumed.

> **History, kept because the symptoms are unforgettable and could come back.** Until 2026-09-21
> this checkout lived under `~/Desktop/知趣·象限/`, which iCloud syncs. iCloud dropped conflict
> copies named `X 2.class` into `target/` and — as we found that day — `AiServiceImpl 2.java`
> into `src/`. Spring's classpath scan then threw `BeanDefinitionStoreException`, or stalled on
> placeholder files with `IOException: Operation timed out`: a 20-second run took 5+ minutes of
> pure scan time, and it reads like a code problem. `mvn clean` could itself fail to delete
> `target`.
>
> Java copies fail loudly ("类重复"). **Static-asset copies do not** —
> `static/assets/zhiqu-api 2.js` is packaged into the JAR and served as a stale copy of the app
> shell, and an HTML copy brings an old cache token with it. That asymmetry is why
> `SourceTreeCleanlinessTest` still fails the build on any `* <n>.<ext>` under `src/`: it costs
> nothing, and it is the only one of the two that nothing else would catch. To clear them by hand:
> `find . -name '* [0-9].*' -not -path './.git/*' -delete`
>
> The checkout now lives at `~/Developer/zhiqu-quadrant/zhiqu-StudySystem` — outside iCloud's
> Desktop/Documents sync and ASCII-only. **Do not move it back under `~/Desktop` or
> `~/Documents`.**

Useful flags when testing locally: `--server.port=18080`,
`--app.ai.allow-private-provider-url=true` (lets you point a model config at a local mock),
`--app.rag.enabled=false` (skip the sidecar).

Stop a local instance **by port, never by process name** (`pkill -f java` will take down unrelated
JVMs — including your IDE's):

```bash
kill $(lsof -nP -iTCP:8080 -sTCP:LISTEN -t)          # macOS / Linux
```
```powershell
Stop-Process -Id (Get-NetTCPConnection -LocalPort 8080 -State Listen).OwningProcess   # Windows
```

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

## 进行中的计划

**zhiqu harness（P0–P7）见 [`docs/zhiqu-harness-plan.md`](docs/zhiqu-harness-plan.md)**。用户要求全部都做、严格按表执行、
不擅自增删；每完成一项更新那份文件的「进度」列。npm 发布（P7）前必须单独问用户。

## Architecture

### Backend (`zhiqu-backend/src/main/java/com/zhiqu/`)

- **`common/`** — `Result<T>` (`code/message/data`), `BusinessException`, `GlobalExceptionHandler`.
  All controllers return `Result<T>`; business errors come back as HTTP 200 with `code != 200`,
  so the frontend must check `result.code === 200`.
- **`security/`** — Stateless JWT. `JwtUtils` signs/parses (subject = userId), `JwtAuthenticationFilter`
  reads `Authorization: Bearer <token>`, `SecurityUtils.getCurrentUserId()` scopes every query.
  `RateLimitFilter` throttles per IP: auth 12/60s, **non-GET** `/api/ai/**` 40/60s, other `/api/**` 180/60s
  (429 `请求过于频繁`). Worth remembering when scripting E2E tests — creating many users trips it.
  The client IP comes from `ClientIpResolver`, which honours `X-Forwarded-For` **only** when
  `app.proxy.trust-forwarded-headers=true` *and* the immediate peer is loopback/site-local —
  so the header cannot be spoofed from outside, and the default (false) is safe behind no proxy.
  When Redis throws, the filter falls back to `LocalRateWindows` (in-process sliding windows).
  That fallback used to be a **memory leak**: entries were only ever created, never removed, so
  every `(ip, limit)` pair ever seen stayed until restart — and with Redis absent that is *every*
  request. It has no functional symptom (limiting keeps working perfectly), which is why it needs
  a judgment on `size()` rather than on "was it limited". It now sweeps, but only when the map is
  over `SWEEP_THRESHOLD` **and** `SWEEP_INTERVAL_MS` has passed, so normal load never pays the
  O(n) scan. A key only becomes garbage because its IP *stopped coming back*, which its own next
  call can never discover — hence a sweep that something else triggers.
- **`config/`** — `SecurityConfig`, `CorsConfig`, `WebMvcConfig`, `MyBatisPlusConfig`
  (registers `OptimisticLockerInnerInterceptor` + pagination; `MetaObjectHandler` fills
  `createdAt`/`updatedAt`).
- **`controller/` → `service/` → `mapper/`** — thin controllers, logic in service impls.
- **`rag/`** — client, retriever, index worker and admin surface for the optional Python sidecar.
- **`entity/`** — core: `SysUser`, `StudyTask`, `StudyRecord`, `StudyRoutine`, `AchievementDef`,
  `UserAchievement`. AI: `AiConversation`, `AiMessage`, `AiModelConfig`, `AiNotebook*`,
  `AiAgentRun/Step/Task/Artifact`. Wiki: `UserKnowledgePage`, `UserKnowledgeRevision`,
  `KnowledgePatchSet`, `KnowledgeSource`, `KnowledgePageLink`. RAG: `RagIndexJob`,
  `RagIndexGeneration`, `RagSourceIndexState`. Soft delete via `deleted` (0/1).

### 桌面应用（原生 macOS 外壳）

`deploy/desktop/package-macos-native.sh` 产出一个真正的 Cocoa 应用：Swift + WKWebView 外壳，
JVM 作为子进程，页面无边框铺满窗口，并封成拖拽安装的 `.dmg`。Windows 版见 `package-windows.ps1`
（只能在 Windows 上打，jpackage 不做跨平台）。

三个只在**打包产物**里出现、且报错指不到原因的坑，都已修并有判据：

- **`ApplicationRunner` 比 `ApplicationReadyEvent` 先跑。** Spring Boot 先 `callRunners()`
  再发 ready 事件，所以 runner 里读不到实际端口。`DesktopLauncher` 现在只用一个
  `@EventListener(ApplicationReadyEvent.class)`。
- **Spring Boot 默认 `java.awt.headless=true`**，`Desktop.isDesktopSupported()` 必然 false。
  开浏览器改走 `/usr/bin/open` / `rundll32` / `xdg-open`（`BrowserOpener`）。
  而 headless 的 JVM 不连 CoreGraphics 窗口服务器，macOS 会**无限弹跳 Dock 图标**
  （`lsappinfo` 报 `!cgsConnection`）。jpackage 版必须传
  `--java-options "-Djava.awt.headless=false"` —— `spring.main.headless` 绑定在
  `configureHeadlessProperty()` 之后，**写了也不生效**。原生外壳版相反：JVM 保持 headless，
  外壳自己才是 GUI 进程。
- **jlink 漏了 `jdk.charsets`**，MySQL 驱动把连接字符集协商成 `eucjpms`，
  所有中文明文写入报 `Incorrect string value`。表、列、JDBC URL 三处都写着 utf8mb4。
  任务标题是加密存储的（明文进 `encrypted_title`），所以只有 Wiki 受影响。
  `jdk.crypto.ec` 同理：缺了 HTTPS 握手失败，报错像是对端的问题。

原生外壳与后端靠 `-Dzhiqu.desktop.port-file` 交接端口（临时文件 + 原子改名 —— 外壳是
轮询这个文件的，直接写可能读到半个端口号）。设了这个属性后端就**不再弹浏览器**。

**桌面应用的工作目录是 `/`**（从 Finder / Dock 启动，实测 `user.dir=/`）。所以凡是按
`user.dir` 解析的相对路径，在桌面版里都指向只读的根目录 —— `app.upload-dir`（头像、分享计划）
和 `app.private-upload-dir`（AI 资料原件）两个都中招。2026-09-23 的样子：⌘V 贴一张图，
界面写「已附到下一条消息」，模型却说看不到、资料区下载为空 —— 原件写不进 `/private-uploads`，
而那段代码是 `catch (Exception ignored)`，之后照样标 `UPLOADED`。`application-desktop.yml`
现在把两个键都设成 `~/.zhiqu/` 下的绝对路径；`DesktopUploadDirTest` **从代码里扫出**所有相对的
`*-dir` 键再核对（不手写名单 —— 第一版就只改了 `upload-dir`，贴图照样坏）。落盘失败时图片标
`ERROR` 并写明原因（文本资料只是降级：文本已从上传流抽出），读不到原件的图也会告诉模型。

### npm 版 `zhiqu`（`zhiqu-cli/`，harness：循环与工具在用户电脑上）

零依赖的 ESM 包，`cd zhiqu-cli && npm link` 装到本机（发布到 npm 之前单独问用户；`package.json` 留着
`"private": true` 挡误发）。服务器那一侧见上面「命令行 harness 的服务端网关」。它接替了下面那个 Java 版的
`zhiqu` 命令（本机 `/opt/homebrew/bin/zhiqu` 旧软链已移走；桌面包里仍带着 Java 版）。不看代码想不到的几件事：

- **三档权限 plan / ask / auto**（用户定的）：plan 只下发读工具 + `exit_plan_mode`，批准计划才切档；
  ask 写 / 跑前给 diff、问 y/n；auto 不问、做完再汇报。**「下发了什么」和「能执行什么」是同一份清单**，每轮重算。
  MCP 工具第一次用三档都问（第三方写的）。
- **本地安全规则与服务器端是同一套**，共用 `conformance/workspace-rules.json`：Java 的
  `WorkspaceRulesConformanceTest` 与 JS 的 `zhiqu-cli/test/conformance.test.js` 跑同一份，
  `HarnessCliNodeSuiteTest` 把 JS 那一侧接进 Maven 全量 —— 两边各自绿不算数，结论一致才算。
  写这份用例时查出「禁行内代码」只做精确匹配：`--eval=…`、`node -pe`、`python3 -Bc` 都能绕过，`npm exec` 会跑没看过的包；
  两边一起收紧。
- **没读过不许改、只读一部分不许整份重写、确认期间被改过不写**（`local.js` 的 prepare / commit 两步）。
  `write_file` 一个工具三种用法（整份 / append / old_string 替换）—— 长文件分几次写，就是为了不撞单次输出上限。
- **截断不是说完了**：`finish_reason=length` 时截断的调用不执行，历史里的参数换成小而合法的 JSON（带 path），
  回模型「分几次写」。单条工具输出按模型窗口截断（窗口 × 0.35 字）—— 否则小窗口模型一轮就超，两边的压缩都救不了。
- **子进程与 MCP 服务器都不继承命令行的环境**（那里有 `ZHIQU_TOKEN`）。超时杀整个进程组（`detached` + `kill(-pid)`）：
  只杀父进程的话孙子进程攥着管道，close 永远等不到 —— 这条判据因此自带 15 秒时限。
- **配置在 `.zhiqu/`**：`~/.zhiqu/config.json`（600）、`system.md`（第一次写一份内置系统提示，没改过的跟着内置更新，
  改过的不动）；项目 `.zhiqu/settings.json` **不收令牌**。项目说明文件是 `ZHIQU.md`（同目录没有才读 `CLAUDE.md`，
  **不读 `AGENTS.md`** —— 用户定的，和 Codex 的重复）。Skills 三层渐进式披露。会话在 `.zhiqu/sessions/*.jsonl`，
  `/resume` 重放，没有结果的工具调用补「被中断」。
- **测试**：`cd zhiqu-cli && npm test`；端到端用 `test/fixtures/mock-model.cjs`（脚本化的 OpenAI 兼容假模型）与
  `mock-mcp.cjs`；`fake-harness.js` 是进程内的假 `/api/harness/**`（延迟与故障可脚本化：闪断、502、卡死、心跳、
  输出一半断开）。`package.json` 是 `"type": "module"`，所以 CommonJS 的夹具必须是 `.cjs`。
- **goal 模式**（`/goal <目标>`、`--goal`，用户要的「圣目标」）：目标置顶进系统提示；模型只有调 `goal_update`
  宣告 achieved（必须附证据）或 blocked（必须写 blocker）才能停，没宣告就收尾会被自动推着接着做；宣告达成后
  **再过一道不带工具的独立核对**（只看目标、证据与真实的工具结果），不过就带着缺口继续；轮数有上限；目标记进会话。
  无人值守（`--goal` 且输入不是终端）的退出码：0 达成 / 2 卡住 / 3 轮数用完。
- **速度：不要用全局 `fetch`，也不要 ESM `import 'node:http'`**（2026-09-24 实测）。调用过一次 fetch，进程退出就多等
  约 2.4 秒；根子是 TLS：环境里设了 `NODE_USE_SYSTEM_CA=1` 时加载 TLS 要把钥匙串里的系统证书全读一遍（1.1～1.5 秒），
  而 **ESM 的 `import 'node:http'` 会顺带把 tls 拉进来**（CommonJS 的 require 不会）。`src/http.js` 因此用
  `createRequire` 加载 http、只在 https 服务器时才加载 https。`whoami` 2.6 秒 → 0.2 秒；`reliability.test.js` 第一条
  钉着「加载 zhiqu 的全部模块不许加载 tls」。
- **重试只在安全的时候**：GET 对闪断与 502/503/504/429 重试两次；POST 只在「连接被拒」（肯定没到服务器）时重试 ——
  中途断开的 POST 可能已经建了草稿；模型流式调用只在**还没有任何实质输出**时重试（服务器在 error 事件里带
  `retryable`：429 / 5xx / 连不上才是 true）。流式有 240 秒空闲超时，服务器每 15 秒发一行 SSE 注释当心跳 ——
  推理模型想一两分钟时，代理和空闲计时都不会误判。存档改成后台队列，失败的下一轮补，一轮只一个请求。
  同一工作区两个 zhiqu 同时改 `setup.json` 会互相覆盖 → 用 `wx` 锁文件（10 秒没动的旧锁清掉）。
  Windows 上 `npm.cmd` 改成 node 直接跑 `npm-cli.js`（不经过 shell），其它 `.cmd` 明确拒绝。
- **输入框一直在**（用户要的）：交互终端里一轮开始后，底部固定一块活动区（流式的半行、排队的消息、状态行、readline 的
  输入行）；输出先擦掉活动区、成行的永久打印、再画回来，输入行交给 readline 自己重画（画之前把它的 `prevRows` 归零）。
  干活时按回车 = 排队，这一轮结束后自动发出并留下「› 消息」。**权限确认只认问出来之后新打的那一行**（原来会先从队列里
  拿，一句排着的「再加个功能」会被当成对「写入？」的回答）。判据用 `test/vt.js`（迷你终端模拟器，`\n` 按 ONLCR
  当 `\r\n` —— libuv 的 raw 模式保留了它）逐字节回放输出再看屏幕。
  **答过的确认要留在屏幕上**：第一版答完之后，问题连同回答跟着活动区一起被擦掉 —— 用户翻回去看不到自己批准了
  什么计划、同意写了哪个文件（2026-09-25 用户贴的记录里一个确认都没有）。而且擦除的行数按「› 」算，长问题折行时
  擦少了，停在半行的流式输出会被重打一遍。
- **工具名编错了要说「没有这个名字」，不能说「这一轮没给」**。模型会把别家 agent 的 `replace` / `edit_file` / `bash`
  带过来；原来一律回「这一轮没有给你这个工具」—— 听着像暂时的，模型重试三次、自己编一句「现在可用了」，最后放弃替换、
  整份重写了文件（用户实测）。现在分两种：存在但这一档不给（说档位）/ 根本没有（说不是暂时的、该用哪个、怎么用；
  别家常见名字各有指路）。网页端 code agent 同理（`CodeWorkspaceAgent.refusal`）：原来那句「如实告诉用户你没有这个能力」
  对编出来的名字是错的 —— 写工具明明下发了，模型会去说「我改不了文件」。那边的拒绝要保留「操作被拒绝」前缀，
  执行轨迹靠它显示（第一版漏了，是判据读轨迹时红出来的）。
- **`delete_file`**（用户要的）：规矩照写入 —— 这段会话读过或写过、之后没被改过才能删，确认期间被改过不删；
  不是抹掉而是挪进 `.zhiqu/trash/<时间>/`；ask 档单独一道确认、单独一个「本会话都允许删除」（允许了写不等于允许了删）。
  `run_command` 仍不许 `rm`，拒绝时指到 `delete_file`。
- **模型不许写、不许删 `.zhiqu/` 与 `.git/`**（`LocalTools.protectedDir`）。原来 `.json` / `.md` 在扩展名白名单里，
  模型能改 `.zhiqu/settings.json`（给自己加允许的命令）、`.zhiqu/mcp.json`（下次启动就拉起它写的服务器）、
  `system.md` / skills（改自己的规矩）—— auto 档连问都不问。判定按软链解开后的真实位置、大小写不敏感
  （`.zhiqu` 还不存在时 macOS 上建出来的 `.ZHIQU/mcp.json` 就是它）。放在命令行这一侧，不进与服务器共用的 `WorkspaceGuard`。
  这是写 `delete_file` 的判据时顺带红出来的：「.zhiqu 里的不许删」那条一开始被「没读过不许删」替它挡着，补上「先读过」才看清写也没拦。
- **输入 / 弹出命令菜单**（用户要的）：`src/commands.js` 是命令清单的唯一出处，`/help` 与菜单都从它来。菜单就是输入行上方
  的几行，和活动区同一套擦 / 画（空闲时临时建一块只放菜单的区域）；按键从 `keypress` 事件上截（包一层 readline 自己的
  监听器），菜单没开时 ↑↓ 照样翻历史。只在主提示符上弹 —— 续行（行尾 `\`）那一行是正文。
- **`/resume` 把那段会话的聊天记录原样显示出来**（用户要的）：读 `SessionStore.transcript()`，不是 `load()` ——
  后者是发给模型的那一份，压缩过就只剩摘要。不是用户打的 user 消息（goal 推的每一轮、截断时补的说明）记录时带
  `origin`，回放时不冒充「› …」；旧记录没有标记，靠那几句固定开头认。
- **默认服务器**来自 `package.json` 的 `zhiqu.defaultServer`：仓库里是本机桌面应用（测试用），发布版要指向用户的服务器
  （`npm run set-server -- https://…`）；`prepublishOnly` 挡住本机地址、非 https、还挂着 `private` 的版本。

### 命令行 `zhiqu`（Java 版，同一个后端上的 coding agent；已由 npm 版接替）

`deploy/desktop/bin/zhiqu` 随应用打进 `Contents/Resources/bin/`，用应用自带的 JRE 跑
**同一个 JAR** 里的 `com.zhiqu.cli.ZhiquCli`（`PropertiesLauncher` + `-Dloader.main`，不启动 Spring，
0.8 秒起来）。它**只是客户端**：登录、把当前目录设成工作区、按「代码」模式发消息、画出每一步、
草稿在终端看 diff 按 y 落盘 —— 落盘走的是网页确认框同一个 `/api/ai/artifacts/{id}/confirm`。
不自己读写磁盘、不自己跑命令：第二份安全规则迟早比第一份松。对话进名为「命令行」的 Notebook。

几件不看代码想不到的事：

- **根目录护栏在客户端**：在 `/` 或家目录下运行直接拒绝（`--allow-broad-root` 才放行），
  而且在登录**之前**判 —— 不该让人输完密码才被告知这里不能用。
- **后端没开时它自己拉起来**，用 `sh -c 'nohup "$@" … & echo $!'`：非交互 shell 的后台命令
  SIGINT 被置为忽略，JVM 启动时发现已忽略就不装自己的处理器；nohup 再管 SIGHUP。
  直接 `ProcessBuilder` 起的话后端和 CLI 同一个前台进程组，终端里一个 Ctrl+C 两个一起死。
  **这条是实测的，而且实验本身骗了我三次**：执行环境继承下来的信号处置、然后是怀疑掩码，
  最后发现是检测方法 —— `kill(pid, 0)` 对**僵尸进程**也返回「存在」，直接起的那个 JVM 早死了，
  只是没被 `wait()` 回收。对照组一直「活着」，实验就分不出两种启动方式。改成看 `ps` 的状态
  （排除 `Z`）后：直接起的退出码 130，`nohup … &` 起的照常运行。**对照组不死的实验不作数。**
- `zhiqu stop` 只停 pid 文件里记的、且命令行带 `zhiqu.desktop.port-file` 的那个进程 ——
  按端口或进程名去杀会误伤图形界面起的那个。
- 密码用 `Console.readPassword` 读，不是交互终端就拒绝（从管道读密码的脚本迟早把它写进日志）；
  落盘的只有令牌，`~/.zhiqu/cli-token`，600 权限。
- **模型不单独配置**：不指定时后端用用户的默认模型（再退到系统模型），`--model` / `/model <id>` 只对本次会话生效。
  `GET /api/ai/models` 返回的是对象 `{systemModels, userModels, defaultModelId}` —— 第一版 `/model`
  把它当数组遍历，列出来是空白（`CliModels` 照网页的 `normalizeModelList` 拍平）。模型信息带
  `toolCalling`（由 `supportsToolCalling` 一处给出）：选了 Ollama / Gemini 这类不支持工具调用的模型，
  coding agent **静默**不运行，所以启动和切换时都要明说；CLI 不许按 providerType 自己再猜一遍。
- User-Agent 是 `ZhiquCLI/…`（`CliUserAgent`），登录设备列表显示「命令行」。
  `LoginDeviceLabelTest` 把 CLI 的**真实** UA 喂给前端的 `shortUA` —— 判的是一对，
  不是两边各写死一份样本各自为绿（`NodeRunner.run` 为此多了可变参数）。

### 命令行 harness 的服务端网关（P1，`/api/harness/**`）

npm 版 `zhiqu` 的循环和本地工具跑在用户电脑上；服务器只管登录、模型网关、对话存档、远程工具（计划见
`docs/zhiqu-harness-plan.md`）。不看代码想不到的几件事：

- **个人访问令牌（`zqp_…`）只在 `/api/harness/` 下被认**，判定只在 `HarnessPaths.acceptsAccessToken` 一处。
  管理令牌的接口故意放在 `/api/access-tokens`（只认网页登录态）—— 泄露的令牌不能给自己续命、不能批准别的设备。
  库里只存 SHA-256（令牌有 256 位熵，不需要慢哈希）。`AccessTokenScopeTest` 连「控制器挂在哪个路径」「放行名单里没有
  `/api/harness/**` 通配」都钉着。
- **设备码登录**：命令行拿 deviceCode（库里存哈希），用户在个人中心「命令行登录」里输入 8 位码、看过设备名和来源 IP
  之后点允许；命令行轮询换令牌，`WHERE status='APPROVED'` 的条件更新保证并发轮询只签出一张。
- **模型网关**进出都是 OpenAI 格式；Anthropic 的翻译只在 `AnthropicFormat` 一处（服务器端 code agent 的
  `ModelProviderClient.callToolTurn` 也用它 —— 此前 Anthropic 配置被标成支持工具调用，请求却是 OpenAI 格式）。
  流式里工具名一到就发 `tool_call`、参数每长 2KB 发一次 `tool_progress`：模型写大文件时不是一段沉默。
  供应商嫌 `max_tokens` 大（400）就按 8192 → 4096 重试；按模型窗口最后兜底裁剪（按「一轮」丢，工具调用与结果永远成对）；
  SSRF 校验在发请求那一层；用量记进 `harness_usage`，供应商不报就估算并标 `estimated`。
- **远程工具**（Wiki / 计划 / 记忆）写类一律是草稿：计划、记忆挂在这段会话自己的那一轮 `ai_agent_run` 上，
  网页打开这段会话的 Notebook 就能确认。Wiki 的「这一轮读过什么」按「用户 + 会话」存在进程里（服务重启丢失 =
  要求重读，是安全的方向）。
- **一段命令行会话 = 网页里一个 Notebook**，存档只收 user / assistant。完整记录在工作区 `.zhiqu/sessions/`，那是 `/resume` 用的。
- **模型输出被截断（`finish_reason=length`）不是「说完了」**：原来工具循环把截断的回复当成正常结束，静默收尾 ——
  用户看到的是「一直卡在同一步」。现在抛 `ToolTurnTruncatedException`，code agent 叙述出来并让模型拆小文件重写。
- **工作区可以新建上级目录了，但不静默**：`newDirectoriesFor` 先报出要建哪些，草稿带着 `newDirectories`，确认框里写出来。
  原先「不替用户建目录」让「放在 test 文件夹里」这种请求直接写失败。

### 稳定性 / 可靠性 / 速度（2026-09-24 第二轮，网页端）

- **网页请求**（`zhiqu-api.js` 的 `request`）：30 秒超时（上传 3 分钟）；GET 对断网、超时、429、502/503/504 重试两次，
  写操作只在 429 时重试（限流过滤器在业务之前拒的，肯定没处理；断网 / 502 的写操作可能已经生效了）；
  代理回 HTML 时说「服务器暂时不可用」而不是 `Unexpected token <`。判据 `request-check.js` 直接跑发布的实现。
- **聊天流**：服务器每 15 秒发一行 SSE 注释当心跳（`SseHeartbeats`，网页聊天与命令行网关共用），前端 75 秒一个字节都
  没收到就主动断开 —— 原来连接悄悄死掉时读取会永远等下去，界面停在「发送中」，「断线后从库里接回」没有机会启动。
  前端 `parseSseFrame` 把纯注释帧当成「不是事件」，而不是一个空的 message。
- **知识 Wiki 打开变快**：`documentTree` 不再解密、返回每一页的正文（前端从不用它，打开某页时还会再取一遍）；
  系统页（index / log / 维护规则）内容没变就不写库 —— 原来每次打开都重新加密、UPDATE、重建链接，一次读变三次写，
  系统页版本号跟着每次读一起涨。改名前先确保正文已取回（整页保存要带正文，否则后端拒「内容不能为空」）。
- **清空记忆**一条语句软删全部消息（原来逐条 `deleteById`，几千条消息就几千条 UPDATE，全程占着用户锁）。
- **坏密文只有一种失败方式**：`AesGcmCipher.decrypt` 原来把运行时异常原样放行，而这个 JDK 上比 GCM 标签还短的密文
  抛的是 `ProviderException` —— 一页坏数据能让 RAG 整批索引中断。这是 `RagUnitRegistryIntegrationTest` 在
  **第一次真正开着 Docker 跑全量**时红出来的：本会话之前 147 条集成测试一直在「跳过」。开 Docker：`open -a Docker`，
  然后 `mvn -o clean test` 不加 `-Dzhiqu.skipDockerTests`。

### 稳定性 / 可靠性 / 速度（2026-09-25 第三轮：提醒、成就、统计）

- **提醒「到没到点」用 `BusinessClock.now()`**（`ReminderScheduler`、`ReminderPlanServiceImpl`）。`scheduled_at` 是用户的
  墙上时间（截止日早八、自己填的提醒时间），原来拿 JVM 默认时区的 `LocalDateTime.now()` 去比 —— UTC 主机（Docker 默认）
  上早八那一次 now 是 00:00，当天的提醒一条都不算到期，下午四点才被五分钟那一路捡走。`ReminderClockTest` 把 JVM
  默认时区**设成 UTC** 再判：东八区的开发机上裸 now 恰好是对的，不换时区这条判据是个看不见 bug 的绿。
  审计时间戳（`createdAt` 之类）仍然用 JVM 时区，没动 —— 全局改默认时区会让库里已有的时间戳整体挪位，那是数据决定。
- **提醒渠道的 HTTP 都走 `ChannelEndpoints.HTTP`**（连 5 秒、读 10 秒）。原来三个渠道各自 `new RestTemplate()`，
  没有任何超时；而 `@Scheduled` 默认只有一个线程 —— 推送服务器挂住一个连接，早八提醒、到期提醒、RAG 索引 worker 全停，
  一行日志都没有。调度线程池没有加大：RAG 的两个定时任务原来从不并发，放开要先审它们。
- **企业微信 Webhook 只认 `https://qyapi.weixin.qq.com/cgi-bin/webhook/send`**，保存时、发送时各判一次（库里的旧值也挡住）。
  原来任何登录用户都能填 `http://169.254.169.254/…`，点「测试发送」让服务器替他敲内网，失败原因（含对端返回的片段）
  原样回到页面上。用白名单而不是「拒私网地址」：后者要解析 DNS、防重绑定，前者一次字符串比较。
- **发提醒按人兜底、按条兜底**。`PROCESSING` 原来只进不出：认领之后任何一个异常（一条坏密文、一次查询失败）都让整批
  —— 包括排在后面的别人 —— 永远停在「处理中」。现在每轮先 `recoverInterrupted()`：认领超过 60 分钟没结果的，
  第一次放回队列（`failure_reason` 记下标记），第二次判死并写明原因。**两条 SQL 的先后就是「只重试一次」的全部实现**
  （先判死重排过的、再重排）；第一版在重排那条里另加了「排除已标记的」，结果两道防护互相替对方挡着，哪一道删掉都不红 ——
  扰动时才看出来，删掉了多余的那道。时间全用数据库的 `NOW()`，和 `claimPending` 写 `updated_at` 同一个时钟。
- **成就检查用 COUNT、按需**。登录、建任务、完成任务、记学习、打卡都会走到 `checkAndUnlock`，原来每次把这个人全部任务和
  学习记录整行取回来（加密正文一起）只为数个数，全部成就解锁了也照搬。现在只查还没解锁的成就用得到的计数，每种一次；
  全解锁了一条都不查。`StudyCountingIntegrationTest` 用迁移里种的真成就定义对照原算法，数据专门让每个阈值只对一种错误敏感。
- **统计页**一条 `GROUP BY`；**学习时长趋势**改成设计稿的样子：最近 14 天 / 7 周 / 6 个月、连续、没学的那格是 0。
  原来返回全部历史（几百根柱子挤一行），缺席的日子直接不出现，周的键用 `getYear()` 配「按周计年」的周序号 ——
  2024-12-30（2025 年第 1 周）的键是 `2024-W1`，和一年前真正的第 1 周**合并**成一根；键没补零（W10 排在 W2 前）；
  一周从哪天开始跟着服务器的语言走。现在 ISO 周、键补零，另给一个 `label`（「6/20」「第25周」「6月」），前端本来就优先显示它。

### 稳定性 / 可靠性 / 速度（2026-09-25 第四轮：首页、例行计划、参考计划）

- **按日期逐天展开的区间有上限**（`common/DateRange`，366 天）。`/api/dashboard/overview` 与 `/api/routine/instances`
  原来 `from` / `to` 原样照收：一个登录用户请求一百年，服务器逐天展开三万六千多天、每天再遍历一遍例行计划。
  页面实际只要一周。
- **首页只取用得到的任务**（`DashboardController.relevantTasks`）：没完成的、日期在所看区间里的、日期是今天的 ——
  正好是 `build` 里每一处筛选的并集，「日期」照 `taskDate`（有开始时间看开始时间，没有才看截止时间）。原来每次打开
  首页都把全部任务整行取回来、逐条解密标题再在内存里筛，用得久的人绝大多数是早完成的旧任务。
  `DashboardOverviewEquivalenceIntegrationTest` 拿同一个 `build` 喂全部任务和筛过的任务、比输出 —— 但**多取了输出
  也一样**（build 会再筛），所以另外钉「取回来的正好是那个集合」，否则查询条件放宽了也看不出来。
- **早八查「今天打过卡没有」不再一条一查**：按 `routine_id` 分批 `IN`（500 一批）。只按日期查用不上索引（打卡表的
  两个索引都不以 `check_date` 开头），会整表扫描；分批 IN 走唯一键 `(routine_id, check_date)`。仍然核对 `user_id`。
- **参考计划列表**分类名一次取全、「我点过没有」一次查完（原来每行两次查询，两百个计划四百次）。批量查点赞必须带
  `user_id` —— 单元判据的 mock 看不出漏了它（不管查什么都返回同一批），是真库判据补上的。
- **参考计划的两个计数只改自己那一列**（`SharedPlanTemplateMapper.incrementApplyCount` / `refreshLikeCount`）。
  原来「读出整个模板 → 改计数 → `updateById` 整个写回去」：并发套用丢计数；更糟的是写回的是读的时候的状态 ——
  管理员恰好在这中间驳回或下架，点一下赞、套用一次，它就又变回「已通过」。这张表没有 `@Version`，没有东西拦。

### 稳定性 / 可靠性 / 速度（2026-09-25 第五轮：登录与会话）

- **改密码吊销旧令牌**（V37 `sys_user.token_epoch`）。JWT 无状态，原来改了密码旧令牌照样能用到过期（记住我 30 天）——
  而改密码正是账号被盗后用户能做的那件事。令牌带着签发时的纪元（`JwtUtils.EPOCH_CLAIM`），过滤器本来每次请求就要读
  这一行（查禁用），顺带比纪元，不多一次查询。用计数不用「改密码的时间」：不牵扯时钟、时区。旧令牌没有这个声明按 0 算，
  上线时谁都不会被踢下线。`generateToken` 没有不带纪元的重载 —— 那样签的令牌对改过密码的人永远无效，签发处看不出错。
  改密码接口给当前会话回一张新令牌（到期时间照旧，带着记住我 Cookie 的也换 Cookie），前端 `setAuth` 存上，
  否则改完密码下一个请求就被踢回登录页（`PasswordChangeKeepsSessionTest`）。管理员重置密码同样吊销。
  个人访问令牌（`zqp_`）是另一套，不受影响。
- **改密码是一条只动几列的语句**（`SysUserMapper.changePassword`，并把 `version` +1）。原来读整行、改密码、`updateById`
  写回：`sys_user` 有 `@Version`，中间谁改过这一行那次写入就是 0 行，接口照样回「密码已更新」；反过来一个并发的整行写入
  会把旧密码哈希写回去。
- **用户名存不存在，不能从响应时间看出来**：不存在时也拿一个占位哈希比一次（原来直接返回，存在才做约 100 毫秒的 BCrypt）。
- **客户端 IP 只有 `ClientIpResolver` 一种算法**。登录记录、反馈、后台流量监控原来各自直接读 `X-Forwarded-For` ——
  登录记录是给用户看「是不是我登的」的，谁都能给自己填一个假 IP。`LoginSafetyTest` 钉「src/main 里只有它读这个头」。
- 顺带：登录回包里 `Map.of` 遇到空昵称直接抛（库里昵称为空的账号每次登录都是 500）。

### 稳定性 / 可靠性 / 速度（2026-09-25 第六轮：用户这一行的写入、上传、配置）

- **`sys_user` 不再有「读整行 → 改 → `updateById` 写回」**：资料、头像、管理员改状态都换成只动自己那几列的语句
  （`SysUserMapper.updateProfile / updateAvatar / updateStatus`，加上第五轮的 `changePassword`），并检查行数。
  这张表有 `@Version`，原来中间谁动过这一行，写入就是 0 行而接口照样回成功 —— 管理员点了「禁用」，账号其实没禁用。
  另一个藏着的：`updateById` 跳过 null 字段，个人资料把学校 / 专业 / 邮箱**清空根本写不进去**，旧值一直在。
  **竞态在一次请求的中间，集成测试摆不进去**：第一版在请求之前用 JDBC 改版本号来「模拟冲突」，扰动 U8（把禁用改回整行写回）
  照样绿 —— 请求里读到的已经是新版本号，整行写回照样成功。机制改由 `AdminUserStatusTest` 钉（只调 `updateStatus`、0 行要报错）。
- **换头像删旧文件**（只删自己的、解析后正好在头像目录里的那一张 —— 库里的 avatar 是个字符串，不能它说删哪个就删哪个）。
  原来每次上传都留一个文件、永不删，一个人反复传 5MB 头像一分钟能写进将近 1GB。写库失败时刚存的文件也删。
  第一版同时有「名字里不许有 /」和「规范化后必须在目录里」两道，扰动发现它们互相替对方挡着，删掉了字符串那道。
- **Raw Source 截断要说出来**：粘贴原来只存 12000 字、上传 20000 字，截了一个字都不说（两百页的 PDF 只剩前几页，
  用户以为整份都在 Wiki 里）。现在一个上限 `MAX_SOURCE_CHARS`，回包带 `truncated: {kept, total}`，页面照说。
- **`ProdConfigParityTest`**：`application.yml` 的每个键生产模板里都要有 —— 生产配置是替换不是追加，漏一个就静默回到
  Spring 默认值（比如上传上限 1MB，线上传不了、开发机上好好的）。此刻两边一致，这条让它们一直一致。

### 稳定性 / 可靠性 / 速度（2026-09-25 第七轮：没有 Redis 的时候）

- **锁与幂等在 Redis 连不上时退回进程内**（`RedisDistributedLockService`、`IdempotencyService`，共用 `LocalExpiringStore`）。
  限流早就这么做了（`LocalRateWindows`），这两个没有 —— 2026-09-25 实测：Redis 连不上时任务页「快速添加」（总带着
  `Idempotency-Key`）回的是 `Unable to connect to Redis`，同一个请求不带这个头却能成功；提醒调度拿锁直接抛，一条都发不出去。
  **桌面版和配置里从没提过要装 Redis** —— 这台机器上恰好装着，所以一直没人发现。单实例部署（桌面、小服务器）上进程内的锁
  就是对的；多实例而没有 Redis，本来就谈不上互斥。修完之后同样的实测：两次带同一个键的添加回同一个任务 id，没有重复。
- **放锁不抛异常**：它总在 finally 里，一抛就把前面已经成功的写操作报成失败，客户端一重试就是重复写入。
  进程内的锁只放自己那一把（过期后被别人拿走的不能误放）。
- **任务的密文不进接口回包**（`StudyTask` 上 `@JsonIgnore`）：页面从不读，每条任务却带着明文 + 密文两份标题和描述。

### 稳定性 / 可靠性 / 速度（2026-09-25 第八轮：套用只执行一次、一次请求写多少行）

- **参考计划「套用」只执行一次**：沿用任务快速添加那套 `Idempotency-Key`（第七轮起没有 Redis 也能用），scope 带计划 id。
  **键在打开计划时生成，不在点击里生成** —— 每次点击新生成一个键就等于没去重；键里带上开始日期，换个日期是另一次。
  另加「请求没回来之前按钮不响应」。真浏览器里走过一遍：套用一次建出两条任务，同一个键再发两次都回第一次的结果，任务还是两条。
  （顺带看到：这个界面里「双击」开不出两个日期框 —— 第二下点在弹框的遮罩上把它关了；真正的风险是等得不耐烦又点、和重试。）
- **一次请求写多少行有上限**：周期任务最多 52 周（`StudyTaskServiceImpl.MAX_REPEAT_WEEKS`），每个任务最多 10 个提前提醒
  （`ReminderPlanServiceImpl.MAX_OFFSETS`）。原来都没有：`repeatWeeks = 1000000`（或 AI 草稿里模型随口写的 520）就是一个事务里
  几百万行写入。判定放在服务里而不是请求 DTO 上 —— AI 草稿确认、参考计划套用都不经过 `@Valid`。超了就拒绝并说清上限，不悄悄截断。

### 第九轮（2026-09-27）：复杂任务、长输入、一次做对 —— 命令行与网页

用户原话：「提高处理复杂任务的能力和长上下文输入时的分析和工作能力」「还要提高任务处理的准确率」
「叫它干一个活不要一直偏离然后一直修正，最好一次就成功」，外加「输入之后、显示模型处理之前输入框还是会短暂不见」。

**命令行的输入框**
- **重画一次写完**（`Ui.frame`）：擦活动区、打输出、画回输入行原来是分开的几次 `write`，终端在中间刷一帧就是
  「输入框不见了」—— 等模型时状态行每秒刷一次，流式每个增量一次。现在一帧攒成一次写，外面包 DEC 2026 同步输出
  （支持的终端整块换帧，不支持的忽略）。一轮结束到下一个提示符也是一帧（repl 里 `endLive` + 空行 + 提示符一起写）。
  **判据必须按每一次 write 分别回放**（`redraw-paste.test.js`）—— 只看最终屏幕，分几次写和一次写完长得一样。
  pty 实录：回车到回答结束，改之前 33 次终端读到输出、11 次底下没有输入行；改之后 16 次、0 次。
- **粘贴多行是一条消息**：原来五行报错 = 第一行立刻发出 + 其余每行各排一轮。开括号粘贴（DEC 2004），粘贴内容
  自己攒、不交给 readline（交给它的话每个换行都是回车）；有换行或超过 500 字就在输入行放 `[粘贴 #n · L 行]`，
  回车时换回原文。擦除行数按**屏幕上的占位**算，不按展开后的原文（按原文算会把上面的输出擦掉 —— 扰动照出来的）。
  终端不支持括号粘贴（旧 Windows 控制台）时兜底：同一批到达的几行合成一条（人一行一行打不可能落在同一批）。
  y/n 确认不参与合并。
- 第一轮等 MCP 启动时输入框也在（原来 `await mcpReady` 在 `beginLive` 之前）。

**命令行的准确率（「一次做对」）**
- **read_file 按这个模型一次能看的量读**（agent 传 `maxChars`）。原来按 10 万字切、agent 再按窗口×0.35 从中间截断 ——
  头部写着「共 300 行」、`known.full` 也记成读全了，模型只看了前一段却被允许整份重写，没看到的部分被冲掉。
  一行就超上限（压缩过的 js）也不算读全。
- **替换对不上时给线索**：先按「忽略空白」找同样的几行 —— 找到就说第几行、原文一字不差是什么；找不到再说第一行在哪
  （那段多半被改过了）。原来只回「没找到」，模型凭记忆再拼、又错，几轮之后放弃替换、整份重写。
  **CRLF 文件**：多行 old_string 原来永远「没找到」；现在在统一成 `\n` 的文本里换、写回 `\r\n`（混着两种换行的不动）。
  出现几处时说出行号，`replace_all` 一次全换。搜索结果**保留缩进**（模型常把搜到的那行直接当 old_string）。
- **打转检测**：同一个文件连续改不成、同一条命令同样失败，到第 3 次在工具结果后面附一句提醒（重读原文 / 找根因），
  不拦；成功一次、用户说新的一句话都重新计数。
- 系统提示新增「一次做对」一节：先弄清楚再动手、牵涉的地方一次改齐、验证一次、失败找根因、只做用户要的、收尾对照原话。

**命令行的复杂任务与长输入**
- **任务清单 `update_todos`**（`src/todos.js`，三档都有）：整份替换；终端显示；**置顶进系统提示**（压缩压不掉，全做完了就不占）；
  记进会话、`/resume` 接回来；没做完就收尾时推一次（在问问题 / plan 档 / 已推过都不推）。
- **用户这次的原话**：对话被压缩、原文不在 messages 里时置顶进系统提示（摘要是转述，「但 localhost 的不要动」在转述里最容易丢）。
- **很长的输入**（超过窗口 30%）存成 `.zhiqu/inputs/*.txt`（超过 200KB 分几份），消息里给开头、结尾、路径，模型用
  read_file / search 分段读。原来整块塞进去：超窗口的整个请求被供应商拒，没超的把模型的地方占满。
- **压缩**：记录太长时**分块滚动摘要**（原来从中间砍掉一段再摘，那段里的决定就没了）；**用户说过的原话逐字保留**
  在摘要消息后面（有预算，超了先丢最早的并说出来；再压一次接着带上）；摘要的输出上限跟着窗口缩（窗口 8000 写 4096 token
  的摘要，压完比压之前还挤）。「哪些 user 消息不是用户打的」收在 `src/origins.js` 一处，回放和压缩共用。

**网页 AI 助手的长输入**（`service/ai/UserMessageFit`）
- 用户消息原来走 `limitText(message, 12000)` —— 那个函数**先把所有空白压成一个空格**：粘贴的代码 / 日志在模型眼里是一整行
  （Python 连缩进都没了），存进库的也是压平的（刷新后自己发的代码成了一行）；超过 12000 字从后面截掉、一个字不说。
  现在换行缩进原样；上限跟着模型窗口（没填窗口仍是 12000，填了按 40%）；超了**保留头尾截中间**，正文里写明，页面弹 `message.notice`。
- 最终回答入库原来也截在 12000 字（流式看到全文，刷新后半截没了）→ `REPLY_MAX_LENGTH` 20 万。

**Windows 打包脚本**：`mvn -o` 在新机器上必失败 → 去掉；PowerShell 5.1 不因原生命令失败停下 → `Assert-Exit` 查 `$LASTEXITCODE`
（`WindowsPackagingScriptTest`）。jpackage 默认模块集已实测含 `jdk.charsets` / `jdk.crypto.ec`，没有 macOS 版那两个坑。

### 第十轮（2026-09-28）：网页 code agent 一次做对、写完即查语法、桌面启动快一半

**网页 code agent（`CodeWorkspaceAgent`）追上命令行第九轮的几件事**
- **按原文替换一段**：`write_workspace_file` 原来只收「修改后的完整内容」—— 改 800 行文件里的三行也要整份重写，
  顺手改掉别处、漏一段、撞输出上限都是这里来的。现在 old_string / new_string / replace_all，同一个文件多次替换叠在同一份草稿上；
  替换要先读过、读过之后指纹变了就拒。**规矩只有一套**：`service/workspace/TextEdit.java` 与 `zhiqu-cli/src/tools/edit.js`
  跑同一份 `conformance/text-edit.json`（空白集合两边写死，不用 `\s` —— Java 与 JS 的 `\s` 范围不同）。
- **大文件分段读**（`readSlice`，上限 `ContextBudget.toolOutputChars()`）：读全了原样给，没读全在开头写明第几行、用 offset 接着读；
  只读了一部分不许整份重写（`LoopState.fullyRead`）。原来一次给全文（最多 256KB），一个大文件就撑爆小窗口的模型。
- **工具循环的对话有预算**（`ToolLoopContext`，`toolLoopChars()`）：原来没有上限，每读一个文件多一整份，几个中等文件之后整个请求被拒，
  用户看到「工具循环中断」。超了先省略旧的工具输出（**从最旧的开始、只保最新一条** —— 第一版「最近 4 条原样」时判据就红了：
  一次读能给到预算的一半，4 条原样本身就超预算），再不够省略旧调用里的大段参数（写草稿时的整份文件）。

**命令行：写完立刻查语法**（`zhiqu-cli/src/tools/syntax.js`）：JSON（`JSON.parse`；tsconfig / jsconfig / .vscode 是 JSONC，不查）、
JS（`node --check`，只解析不执行、不带环境变量）。**不能原地 --check .js**：实测 node 22 对带 export 的 .js 连真的语法错误也放行（退出码 0）——
按内容定类型，拷到临时目录用 .mjs / .cjs 查。JSX 报的「Unexpected token '<'」不算错。不查 Python：没装命令行工具的 Mac 上一调 python3 就弹安装框。

**桌面应用启动 3.1 秒 → 1.6 秒**（同一台机器、同一个库、交替实测）
- 应用里放**解压后的瘦 JAR + lib/**（`java -Djarmode=tools extract`），不放胖 JAR：胖 JAR 的类走 Spring Boot 自己的加载器，
  既慢又归档不了。单这一步加上运行时的基础 CDS（jlink `--generate-cds-archive`）就到 2.25 秒，第一次启动就有。
- **应用类归档**在用户机器上生成（`deploy/desktop/macos-shell/CdsCache.swift`）：JDK 17 要求类路径一字不差、应用装在哪打包时不知道。
  第一次运行 `-XX:ArchiveClassesAtExit` 写到 `.part`（JVM 退出时才写，约 3 秒，外壳退出时为这一次多等到 20 秒）；
  **只有正常结束（SIGTERM 后自己退出）才改名成正式归档**，被 SIGKILL 的、空的、上次半截的都删。之后 `-XX:SharedArchiveFile`。
  清旧版本时**按文件名比、不按 URL 比**：`contentsOfDirectory` 给回来的 URL 与自己拼的指向同一个文件也可能不相等 ——
  第一版因此把刚生成的归档当旧的删了，`DesktopCdsCacheTest`（编译 CdsCache.swift + 检查程序、不开窗口地真走一遍）红出来的。
- **中文路径会让应用类归档只归档一小部分**（实测：`知趣象限.app` 里 64MB / 2.15 秒，ASCII 路径 86MB / 1.66 秒；与 locale 无关，软链也不行 ——
  JVM 按真实路径算）。所以外壳把 `Resources/app` 拷一份到 `~/.zhiqu/app/<版本>/` 再跑（`AppStage`；APFS 上是克隆；最后写 `.complete`，
  没标记的当半截；拷不成照原样从应用包跑）。`~/.zhiqu/app` 与 `~/.zhiqu/cds` 共约 160MB，删了下次自动重建。
- 命令行 `bin/zhiqu` 改成直接 `-cp` 瘦 JAR 点名入口类（瘦 JAR 里没有 PropertiesLauncher）。

### 第十一轮（2026-09-28）：暴力测试 —— 全接口坏输入

用户要的「暴力的测试…不同输入、不停刷新、没耐心的极端情况」。计划与结果在 `docs/rounds/round-11.md`（每轮的计划都存在 `docs/rounds/`）。

- **`EndpointFuzzIntegrationTest`**：从 Spring 映射表枚举全部 `/api/**`（不手写名单，新接口自动纳入；少于 150 个就判扫空），
  每个接口喂坏输入（空体、错类型、畸形 JSON、10 万字、零宽 / RTL / `<script>` / SQL 片段、溢出的数、2026-02-30、路径给字母），
  管理员和普通用户各一遍。**判据是「坏输入不许变成服务器出错」**：每个请求前后比 `runtime_issue` 里 `source='SERVER'` 的行
  （兜底分支会记一条），外加 HTTP 500 与 20 秒超时。第一次跑出 499 处，修完 0 处。它在全量里，约 45 秒。
  注意 `/api/runtime-issue/client` 本来就往那张表写（`source='CLIENT'`），所以只比 SERVER 行 —— 第一版把它当成了异常。
- **`GlobalExceptionHandler`**：框架层的请求错误（不是合法 JSON、字段类型不对、路径 id 给字母、缺参数 / 请求头、没按上传格式、
  方法不对、日期格式）回 400 并说清哪个字段、应当是什么，**不记运行问题**（原来全落兜底：管理员后台被坏输入刷屏，
  用户看到 `Failed to convert value of type 'java.lang.String'…`）。兜底分支照旧记运行问题，但**不再把异常原文回给用户**
  （原文里有 SQL、表名、类名）—— 回一句话加编号（`reportServerIssue` 现在返回编号）。
  注意 `Result.fail` 的业务错误本来就是 code 500，所以「是不是意外」看的是有没有记运行问题，不是 code。
- 长度按列长校验（用户名 50、昵称 50、学校 / 专业 100、邮箱 120、例行计划标题 200 / 说明 2000 / 类型 50）：
  原来超长直接数据库报「Data too long」（个人资料 10 万字时 MySQL 拒收 1.2MB 的语句）。
- **BCrypt 静默截断 72 字节以后的部分**（这一版 Spring Security 6.3.4，实测 30 个汉字的密码前 24 个字加别的也能登）→
  `PasswordRules.requireStorable` 在注册、改密码两处按字节拒绝。`GlobalExceptionHandlerTest` 里留了一条「截断确实存在」的判据：
  哪天它不成立了，说明依赖改了行为，这条限制可以重新评估。
- 客户端上报运行问题（`/api/runtime-issue/client`）原来在放行名单里、不去重、不限量，而现在的页面根本不调它（只有没人加载的
  旧 `js/common.js` 调）→ 要登录（只由 SecurityConfig 这一道管）、10 分钟内同一条只记一次、每人每小时 30 条。

### 第十二轮（2026-09-28）：命令行 —— 只说结论、不空转、用满模型的窗口

用户贴的真实记录（DeepSeek V4 Pro 在工具调用之间写了上万字推测、反复读同一文件；1M 的模型被按 64000 算、压缩两次）加一句：
「思考内容不要展示出来，用一个动态的小的像素图案来表示在思考，并且说明在思考中，然后只告诉用户结论和更改了什么」。计划在 `docs/rounds/round-12.md`。

- **思考过程不展示**（默认；`/verbose` 或 `--verbose` 切回全显示，记进 `~/.zhiqu/config.json` 的 `showThinking`）：
  模型的回复**收完才打**—— 不调工具的那条是结论，按 Markdown 整段打；调工具的那条里的字是过程，不打。
  读 / 搜 / 列目录 / 没下发的名字 / 参数坏了，只在状态行里一闪（`hushedUi` 把 step 换成 `setActivity`）；写 / 删 / 跑命令照常打印（写带 diff）。
  一轮结束说一句「读了几次文件、搜了几次」。`/resume` 回放同一个规矩。被输出上限截断又接着说的结论，两段都打。
- **像素图案**：`ui.startThinking()`，4 个点阵字符像均衡器起伏（`pixelFrame`，120ms 一帧）+「思考中 Ns · 在做什么」，
  按终端宽度截短（折行的话擦的时候行数对不上）；一轮的 finally 里 `stopThinking`（Ctrl+C 也走这里，定时器不留）。
- **不空转**：调工具的回复里写了 > 3000 字、连续 8 次只看不动 → 工具结果后面附一句（拿不准就写最小复现）；
  发给模型之前，较早几轮调工具那几条回复里的长篇思考只留开头 200 字（`slimThinking`，最近 2 条原样；会话记录里是原话）；
  系统提示新增「少说、多做」。
- **窗口**：模型配置没填窗口就按 `HarnessContext.DEFAULT_WINDOW`（64000）算 —— 启动横幅和压缩时现在都说出来；
  `/window 1m`（也收 `128k`、纯数字）调 `POST /api/harness/models/{id}/context-window` 设自己的模型（范围 8000–1000000，
  与网页同一个 `ContextBudget.validate`）。
- 记录里顺带查出的：`search` 的 path 可以是文件（原来报「不是一个普通文件」，模型以为搜索坏了）；写 .html 也查内联 `<script>`
  （src 外链、非 JS 的 type 不查；module 按 ES 模块；行号对到 HTML）；默认连本机桌面应用而它没开时，macOS 上 `open -g -b com.zhiqu.quadrant`
  打开它、最多等 40 秒（`src/desktop.js`；探测不带重试，否则光探测就 1.3 秒），没装就说清楚、不再报两遍「连不上」。

### 第十三轮（2026-09-28）：暴力测试 —— 连点、刷新、Ctrl+C

「不停刷新、没耐心的极端情况」那一半。计划与结果在 `docs/rounds/round-13.md`。

- **并发暴力测试**（`fuzz/ConcurrencyStormIntegrationTest`，真服务器 + 真库 + 真 HTTP，`CyclicBarrier` 让 20 个请求同时出发；
  `X-Forwarded-For` 配 `app.proxy.trust-forwarded-headers=true` 让每个线程像不同的 IP，否则限流先把它们拦了）：
  同名注册、同一天打卡、同时完成 / 删除任务、点赞、同一幂等键套用、同一草稿确认、同一版本保存 Wiki，各 20 次。查出两个真的：
  - **打卡撞键后的补读必须是加锁读**（`FOR UPDATE`）。MySQL 默认可重复读，普通 SELECT 读的是事务开头的快照，另一个请求刚插进来的那一行
    看不见 → `existing == null` → 把撞键原样抛出去，连点打卡十几次「服务器出错」。
  - **点赞死锁**：普通读计划 → 插 / 删点赞 → 刷计数，并发时拿锁顺序不一样。现在第一条读就是 `FOR UPDATE` 锁计划那一行 ——
    必须是第一条：它不建快照，后面读点赞记录看到的是前一个人提交之后的样子。没有加「死锁就重试」：那会把顺序问题藏起来。
- **集成测试不再连开发机的 Redis**（`src/test/resources/application.properties` 指到 1 号端口，锁 / 幂等 / 限流走第七轮的进程内替身）。
  原来连的是 `localhost:6379`，这台机器上正好开着：每次测试库是新建的、id 从 1 开始，同一个幂等键第二次跑拿到上一次缓存的「成功」，
  一条任务都不建 —— 「同一幂等键套用 20 次」时好时坏，查下来是这个；测试还往用户自己的桌面应用用的 Redis 里写东西。
  并发测试里有一条断言钉着「连的不是 6379」。要测 Redis 本身的用自己的 Testcontainers Redis。
- **AI 回答时狂刷新**（`fuzz/StreamImpatienceIntegrationTest`，假的慢模型）：十个回答同时进行、每个读到第一个字就断开 → 全部照样写完、
  没有停在 STREAMING 的；刚发出就刷新；同一对话不等回答连发 5 条 → 成对、不死锁。查出的是噪音：**每刷新一次记一条运行问题**
  （`IOException: Broken pipe`）。`GlobalExceptionHandler.clientGone` 顺着 cause 链认「对面已经断开」（Spring 的
  `AsyncRequestNotUsableException`、Tomcat 的 `ClientAbortException`、断管 / 连接被重置），不记、不回包；别的 IOException（磁盘满）照记。
- **命令行 Ctrl+C / Ctrl+D**（真 pty 实测出来，`test/interrupt.test.js` 钉住）：
  - **确认提问时按 Ctrl+C，问题原来还挂着**：屏幕上照样是「写入 b.js？」、图案照样在转，用户接着打的下一句话被当成回答吃掉。
    现在 `ui.cancelQuestion()` 把它作废（按不同意算，留一行「（取消）」，答了一半的字清掉）。
  - **确认提问时按 Ctrl+D，这一轮收尾后进程挂住不退**：readline 的 `prompt()` 会顺手 `resume()` 输入流，关了之后收尾时画活动区
    又调了一次。现在画输入行只走 `promptAgain`，关了就不调。
  - **排了消息再按 Ctrl+C，停下之后排队的消息照样被自动发出去**，又干起来了。现在放回输入框（`ui.unqueue()`；多条 / 多行放一个占位），
    回车才发。
  - 连按 Ctrl+C 想让它停：原来第三下就把程序退了。打断之后 `STOP_GRACE_MS`（800ms）内的 Ctrl+C 算同一次「停下」；已经在停了不重复打「已中断」。
  - 真 pty 的暴力脚本（思考中 / 确认时 / 命令运行时 / 模型卡死时按 Ctrl+C、Ctrl+D、10 万字一行、控制字符、坏 UTF-8、括号粘贴 10 万字）
    判：退出码、没有堆栈、会话记录每行是合法 JSON、退出时关掉括号粘贴、命令的子进程不留。**驱动自己也要边写边读**：一次往 pty 写 30 万字节而
    不读，对面回显把输出缓冲写满，两边互等 —— 第一版驱动就这样挂住，看起来像 zhiqu 卡死。

### 第十四轮（2026-09-28）：暴力测试 —— 网页上没耐心的人（真浏览器）

计划与结果在 `docs/rounds/round-14.md`。先在真浏览器里双击 / 连点，再修。

- **`@DeadlockRetry` 只在最外层的事务边界上重试**（`DeadlockRetryAspect`：已经在事务里就原样往外抛）。它标在 15 个服务方法上，
  互相调用（新建例行计划 → 成就检查，两个都带）。两个请求同时解锁同一个成就就死锁，MySQL 回滚的是**整个**事务，
  里层的重试却在那个已经死掉的事务里把成就检查再跑一遍 —— 外层早被标 rollback-only，提交时 `UnexpectedRollbackException`，
  用户看到「服务器出错了」。真浏览器里双击「创建例行计划」撞出来的；`ConcurrencyStormIntegrationTest.同时新建` 钉着。
- **同一个写请求没回来前不重发**（`zhiqu-api.js` 的 `request()`：方法 + 地址 + 内容 + 请求头都一样就共用那一个 Promise）。
  双击「创建」、连按回车原来各建一份 —— 服务器没法替它去重，两次都是合法的新建。回来之后再点是新的一次；GET、上传不走这里。
  直接调 `fetch` 的写操作会绕开它，`RequestResilienceTest.写操作不绕过request` 扫着（只许聊天流，它有自己的发送中保护）。
  **页面上常驻的新建表单建好要清空**（例行计划的标题 / 说明、从任务生成的勾选）：回来之后多点的那一下否则再建一份同名的
  （弹窗一建就关，点不到）。`InlineFormResetTest`。
- **只认最后一次的响应**（`latestOnly(key)`）：来回切「日 / 周 / 月」、改筛选、写完之后的重载，响应可能乱序回来。
  趋势图、任务列表、从任务生成的来源列表、参考计划列表四处用它；`latest-check.js` 拿趋势图真跑。Notebook 切换、Wiki 切页原来就有这道。
- **幂等那一层不改写异常**（`IdempotencyService.execute`）：原来 `catch (Exception)` 一律包成 `BusinessException(e.getMessage())` ——
  带 `Idempotency-Key` 的接口（快速添加任务、套用参考计划、AI 批量建任务）上，日期写错回 Java 原文，真的服务器 bug 把 SQL / 类名
  原样回给用户、**一条运行问题都不记**。第十一轮的全接口暴力测试不带这个头，而且这类 bug 正好把它找的那条运行问题吞了，看不见。
  结果存不进缓存时照样返回（业务已经做完，这时报错客户端会再发一次）。
- **没接住的失败要说出来**（`unhandledrejection` → `reportUnhandled`）：onclick 里 `await api.post` 却没有 catch 的地方
  （套用、点赞、打卡、删除……）失败时页面上一个字没有。请求层的错误都带 `userFacing`，原样说；代码里的错误只说「没有完成」；
  用户自己取消（AbortError）和正在跳登录时不吭声。显式处理照旧优先。
- 连点暴力测试（每页 1.5 秒随机点 60 多下）顺带查出：例行计划的「开始 / 结束日期」HTML 里写死 2026-07-06 → 08-30（设计稿日期，
  过了那天默认值建出来的就是已经结束的计划；现在脚本填 today()，`FrontendTokenAndDateTest.日期输入框不写死日期`）；
  列表把已结束 / 没开始的也当「进行中」、都给「标记完成」（点了只会报错），「5 个进行中」是写死的（`routinePhase`）；
  校验消息的先后每次不一样（校验器内部是 HashSet）→ 按字段在请求类里写的先后排。
- **定时任务的开关是真的开关**（`app.scheduling.enabled`，`SchedulingConfig`，默认开）。27 个集成测试写着
  `spring.task.scheduling.enabled=false` —— **Spring Boot 没有这个属性**，写了等于没写：RAG worker 每秒在每个测试上下文里领作业；
  测试类结束时它的 MySQL 容器停了、上下文还缓存着，worker 卡在连不上的库上，关 JVM 时 Spring 等它 30 秒，surefire 强杀 ——
  第九轮以来每次全量都白等 30 秒，外加结尾那串 `EOFException: Can not read response from server`。现在测试的
  `application.properties` 一处关掉；`SchedulingSwitchTest` 钉「只有一处 @EnableScheduling（全限定名写法也算 —— 第一版只认短名，
  扰动时漏过去了）」「没人再写那个假属性」。**写一个配置属性之前先确认它存在**：Spring 不认识的键不报错。
  关掉定时任务之后全量**还是**被强杀 —— 第二个原因（surefire 强杀前自己写的线程转储在 `target/surefire-reports/*.dump`）：
  `HikariPool.shutdown` 在等「补连接」的线程。为了保住 `minimum-idle`，每个缓存着的上下文的连接池都在往已经停掉的 MySQL 上补连接
  （退避重试，最长 5 秒一次），关的时候各等一阵，二十几个加起来过了 30 秒。测试里 `spring.datasource.hikari.minimum-idle=0`：
  没人等连接就不补。**一个修复不等于那个症状没了**：修完第一个原因要重跑全量看那一行还在不在。

### 第十五轮（2026-09-28）：不丢字 —— 刷新、关页、登录过期、断网时用户打的字还在

计划与结果在 `docs/rounds/round-15.md`。全文件原来没有一处 `beforeunload`、聊天框草稿不存、登录过期一律回看板。

- **草稿只有一套**（`zhiqu-api.js` 的 `drafts` / `keepDraft`，判据 `drafts-check.js` 直接跑发布的实现）：localStorage
  「zq.draft.<用户 id>.<键>」，按用户分开；空了删、太长（20 万字）/ 存储满了 / 隐私模式就不存、不报错；14 天过期；
  **主动退出删这个人的草稿，登录过期不删**。只存用户打过字的：程序把框清空（发送）不算，否则一刷新，空框会把还没确认送达的那句抹掉。
- **聊天框**按 Notebook 分开存；**服务器确认收到（任一事件带 `userMessageId`）才删**；没收到（没配模型、限流、没连上）
  把字放回输入框。`stream.start` 在用户消息落库之后才发，所以它是「存上了」的可靠信号。
- **Wiki 编辑**：打字时存草稿（带开始改时的版本号 base）、换页前先存、关页前浏览器问一句；回到这一页顶上一条「恢复 / 丢弃」。
  恢复后保存按 base 存 —— 这一页之后被改过时乐观锁挡住，**然后每次都挡**（刷新重试也一样，草稿永远存不进去：真浏览器里走出来的
  死胡同），所以改成保存前先明说「别处后来改过，用我的这一版替换吗」，点了才按现在的版本存。取消 = 丢草稿。
- **登录过期**带着原来那一页跳去登录（`index.html?login=1&next=…`），登录后经 `safeNext` 回去 —— 只认本站的 `xxx.html`，
  不然就是开放跳转。那一页上打的字由草稿接住。
- **限流的 AI 桶只算写操作**：原来 `/api/ai/**` 的读也算进 40 次 / 分钟 —— AI 助手打开一次 6 个读，刷新六七次整页「加载失败」；
  回答到一半刷新后每 2 秒轮询一次消息，长回答一分多钟就把桶用完。刷新暴力测试撞出来的（`RateLimitBucketsTest`）。

### 第十六轮（2026-09-28）：命令行遇上坏掉的本地状态和奇怪的文件

计划与结果在 `docs/rounds/round-16.md`。

- **配置文件坏了要说出来，不能悄悄当成「没有」，更不能悄悄覆盖**（`config.js` 的 `readJson` 分「没有」和「坏了」）。
  原来 `~/.zhiqu/config.json` 手改多了个逗号 → 只说「还没登录」；**每次启动记 system.md 指纹时 `saveUserConfig` 还会把它换成
  两个指纹字段**（令牌、服务器地址全丢，一句话都没有 —— 改之前实测过）。现在：一开头说出哪个文件、错在第几列、这次怎么处理、文件没动；
  坏了的时候启动记账不写它；真要写（登录、/verbose）先另存成 `config.json.broken-<时间>` 再写。`.zhiqu/settings.json` 坏了原来
  允许的命令悄悄不生效，现在同样说出来。这些警告原来只在交互横幅里说，`-p` 单发一句都不说 —— 挪到最前面。
- **会话索引坏了从记录文件里找回**（`SessionStore.orphanSessions`）：原来当成空的，下一次写索引就把它整个换掉，聊天记录还在
  `sessions/` 里、`/resume` 却再也找不到。
- **读文件**：二进制（有 NUL、或一成以上是控制字节）不读进上下文 —— 两道判定各管一种，扰动时发现测试文件同时满足两道、互相替对方挡着，
  补了各自单独能照出来的样本；**GBK / GB18030 的文件按它解码**（第一版把它们判成了二进制），不许 `write_file` 改（会把编码换掉）；
  超过一次读的上限的文件**流式读一段**（`offset` 负数 = 最后几行，看日志用）而不是一律拒绝，但不能改；没有读权限说清楚。
- **搜索**：大文件流式扫（512MB 以内），GBK 的按 GBK 解；**跳过了什么要说出来**（二进制、没有读权限、超过 512MB 的）——
  原来太大的、读不了的一声不吭地跳过，「1 处」其实是「能看的那些里 1 处」。列目录：读不了的目录不再显示成「（空目录）」。
- **打到终端上的字先 `termSafe`**（`render/term.js`）：文件名、diff、命令输出、模型的回答里的控制字符变成 `\x1b` 这样看得见的写法 ——
  原样打出去会被终端执行（一个叫 `\x1b[2J.js` 的文件，读它的时候屏幕就清空了）。自己上的颜色在这之后才加；`result` 保留颜色码。

### 第十七轮（2026-09-28）：数据量的极端 —— 用了两年的账号

计划与结果在 `docs/rounds/round-17.md`。在 zhiqu_verify 里造了一个三千条任务、八百多页 Wiki、两万六千条消息、两百个例行计划的账号
（加密字段走接口、其余直接灌库），真浏览器逐页量。

- **页面不许为了显示几十条取回全部**：新接口 `GET /api/task/page`（`{items, total, offset, limit}`，一页最多 500，
  **按 id 兜底排序** —— 只按 updatedAt 排时并列的几条在两页之间先后不定，扰动实测翻页出现了重复的一条）。任务页一次 100 条 +「加载更多」、
  页脚写真的总数（1.6MB / 四万多个节点 → 55KB / 一千多）；例行计划「从任务生成」20 条、番茄钟的任务下拉 50 条、提交参考计划 30 条。
  `DataVolumeFrontendTest` 钉着「zhiqu-api.js 里没有 GET /task/list」。统计页的四象限饼图用 `/record/statistics` 已经数好的分布。
- **统计页「已完成 / 总任务」一直是 0**：页面读 `completedTasks / totalTasks`，接口给的是 `completedTaskCount / totalTaskCount`。
  判据用反射拿 `StudyStatisticsVO` 的字段名去核对页面读的每一个 `stat.xxx` —— 两边各自绿不算数。
- **首页一周 1.1MB → 274KB**：`routineInstances`、`rangeTasks` 页面从不读（和 days 里的重复）；每一条例行计划原来把整行二十几项原样塞进来，
  现在只带页面用得到的（`DashboardController.ROUTINE_ITEM_FIELDS`）。「今天几个番茄钟」只取今天的学习记录（`/record/list?from&to`），原来取回全部。
- **知识 Wiki**：打开一次原来把整个 Wiki 的加密正文从库里搬**五遍**（`findPageByTitle` 为了比标题取全部列 × index / log / 维护规则三次，
  建 index、建目录树各一次）；现在列表查询只取用得到的列（`treeColumns`），目录树的摘要给 120 字（1.2MB → 460KB，220ms → 60ms）。
  **加一页之后第一次打开要 4 秒**：重建 index 时每个 `[[链接]]` 都 `findPageByTitle` 一次（八百多次全表查询）+ 逐条删旧链接 ——
  现在一次取全「标题 → id」、一条语句清链接，0.3 秒。`KnowledgeDocumentTreeTest.查询次数不随页数增长` 拿 30 页和 120 页比查询次数。

### 第十八轮（2026-09-28）：命令行的数据量极端

计划与结果在 `docs/rounds/round-18.md`。造了 500 段会话、一段 4 万条（16MB）的会话、5 万个文件的工作区、一个 300 个工具的 MCP 服务器。

- **配了 MCP 服务器的 `zhiqu -p` 每次多等 15 秒才退出**：`McpManager.start` 里连接超时的定时器连上之后没清，挂在事件循环里。
  实测 15056ms → 76ms；MCP 的测试文件跟着从 10 秒变 6.5 秒（一直没人发现，因为「慢」不报错）。
- **MCP 工具太多时按需给**（`agent.js` 的 `mcpOverBudget` / `find_mcp_tool`）：300 个工具的定义每一轮 15 万字，64K 窗口的模型一大半被占着。
  超过窗口的一成（按一个 token 约 3 个字估）就只给 `find_mcp_tool`，找到的那几个（最多 8 个）从下一次调用起连定义一起给；
  窗口够大（1M）或工具不多照旧全发。跟用户说一次（在第一轮说：启动时还不知道模型的窗口）。
- **`/resume` 回放只显示最后 20 轮**（`REPLAY_TURNS`），并说前面还有几轮、完整记录在哪：一段 4 万条的会话原来往终端灌三万行、2.7MB。
  一轮从用户自己说的一句话开始（goal 推的、系统补的不算）。发给模型的那一份本来就只是最后一次压缩之后的。
- **搜索**：原来最多看 3000 个文件 —— 五万个文件的项目里只搜了开头几十个目录，「0 处」而要找的在后面。现在最多 10 万个、最多 5 秒
  （5 万个文件实测 1.1 秒）；每个文件原来新分配 1MB 的读缓冲，改成一次搜索共用一块。

### 第十九轮（2026-09-28）：模型那一侧不配合

计划与结果在 `docs/rounds/round-19.md`。一个按脚本演坏法的假供应商（真 HTTP、真 SSE、真库）演了 18 种：key 错、欠费、模型名错、
限流、500、502 回 HTML、地址填成官网、空回答、说到一半断、进程崩了、坏 JSON、途中报错、写到输出上限、回一本书、卡住、不说话、连不上、域名解析不了。

- **用户看到的那句话只有 `service/ai/ProviderFailure` 一处出**（网页聊天、测试连接、工具循环、命令行网关共用）：按状态码 / 异常种类说
  下一步做什么，供应商的原因附在后面（JSON 取 message、HTML 整页不要、最多 300 字），遮 key。原来 401 是「AI 接口调用失败：AI 接口调用失败」
  （流式 POST 遇到 401 时 JDK 读不到响应体，原因整个丢了）、502 是整页 nginx 的 HTML、连不上是 `I/O error on POST request for "http://…"`。
  遮 key 是两道各判各的：配置里那一把（不一定长得像 key）、长得像 key 的（不一定是配置里那把）—— 判据原来只用 `sk-` 形状的 key，
  两道互相替对方挡着，删掉哪一道都不红。
- **流读完要核对说完了没有**（`AiStreamAdapterSupport.readSse` / `requireComplete`，命令行网关用同一个读取器）：没有 `[DONE]` /
  finish_reason / message_stop 就是断在半路（`StreamCutOff`）；一行 data 都没有且不是 SSE —— 回的是网页，地址填错了；代理不支持流式、
  回一整段 JSON 的照非流式认出来。商汤的流没有约定的结束信号，不强求（`expectsEndSignal`）。
- **失败时已经收到的那一截留着**（`StreamState.streamedReply` → `failAssistantMessage`）：原来 `updateById` 把正文写成空 —— 用户看着
  一个字一个字出来的半截，刷新就成了空白气泡。失败的半截会进下一轮的历史（`hasText`），这是故意的：用户说「继续」时模型得知道说到哪了。
- **能用但不完整的回答存一句 `ai_message.notice`**（V38）：写到输出上限（可以说「继续」）、被内容审核拦下、太长 —— 收到 20 万字就不再读上游
  （`ReplyCapReached`；原来 300 万字全推给浏览器、库里悄悄只存 20 万）。不复用 `error_message`：那一列的意思是「这一轮失败了」。
- **供应商进程崩了 ≠ 流好好结束但没说完**，这是真浏览器里撞出来的：`com.sun.net.httpserver` 做的假供应商关连接时总会把分块收好尾，
  于是只演得出「干净的 EOF」；真的进程没了、代理把连接掐了，JDK 报的是 `IOException("Premature EOF")`，原来落进兜底的「和模型服务通信失败」。
  `ModelMisbehaviorIntegrationTest.连接硬断` 用原始套接字演这一种。写这个夹具时踩了两个坑：我们的后端发请求用**分块编码**（没有 Content-Length，
  按长度读会读不到头、带着没读的数据关套接字 —— 协议栈发 RST，测到的是 Connection reset）；也不能用 `SO_LINGER 0` 硬断 —— RST 会让对端
  还没读的数据被丢掉，测的就成了「半截没收到」。
- **空回答是失败**：网页原来是一条「完成」的空白回答，网关是一个空的 done（命令行那一轮一个字不打就结束）；网关的空回答标可重试。
- **页面**：失败原因显示在已有正文下面（原来有半截就不说原因，看着像说完了）、刷新之后也在（列表接口一直带着 `errorMessage`，页面从来不读）；
  不完整的说明显示在回答底下；等第一个字时说出等了几秒（网页没有「停止」，模型卡住要 60 秒才放弃）。`msg-failure-check.js` 用对抗性的
  供应商原文判转义 —— 失败原因里有别人服务器上的任意文本。
- 消息列表的行原来有两份一模一样的构造（个人中心的「最近消息」和聊天区），新加的 `notice` 只进了一边 —— 判据红出来的，合成 `messageRow` 一处。
- 顺带：例行计划、参考计划、AI 草稿里的周期显示成「每天」「每周一、三」（`freqLabel`），原来直接是 `DAILY` / `WEEKLY`。
  删了 `AiServiceImpl` 里两个没人调用的旧流式方法（流式早就走 `ModelStreamAdapter`）。

### 启动期密钥守卫

生产由 `--spring.config.location=file:./application-prod.yml` 拉起，它是**替换**而非追加，
所以 JAR 里的 `application.yml` 线上根本不读 —— 唯一现实的失手是照模板抄一份、
`CHANGE_ME_` 忘了填。而两个占位符都长到能通过 `SensitiveCryptoService` 的 `length() < 24`，
服务会干净地起来并用一个公开在仓库里的字符串签发登录令牌。`StartupSecretGuard` 三条判定：
空（一律拒）、`CHANGE_ME` 前缀（一律拒，开发机也拒）、仓库里的开发默认值（仅生产 profile 拒）。
覆盖哪些键不靠记性 —— `StartupSecretGuardTest` 扫模板里每个 `CHANGE_ME` 行反查。

### Frontend (`zhiqu-backend/src/main/resources/static/`)

- **`assets/zhiqu-api.js` is the live application shell** — all 14 HTML pages load it. It owns the
  `api` wrapper, auth guard, navigation, the Wiki UI, the AI assistant UI, agent panels and the
  shared modal helper `openModal({title, bodyHtml, width, onMount}) → {close, body, mask}`.
  `assets/zhiqu-ui.js` / `assets/zhiqu-ui.css` provide the shell chrome and design tokens
  (`var(--zq-*)`).
- **`js/*.js` and `css/*.css` are legacy and are loaded by zero pages.** Do not "fix" behaviour or
  styling there expecting it to take effect — change `assets/zhiqu-api.js` / `assets/zhiqu-ui.css`
  instead. This is not theoretical: the reminder-channel credential UI lived only in
  `js/profile.js`, so 早八提醒 never worked for anyone using the real UI (fixed 2026-09-21).
- **Design tokens have exactly one definition, in `assets/zhiqu-ui.css`'s base `:root`.** A
  `var(--x)` whose `--x` is undefined does not warn — CSS drops the whole declaration and falls
  back to the initial value, so backgrounds and borders silently become transparent. Two of these
  shipped: `--zq-fontM` was never defined at all (the Wiki source editor fell back to bare
  `monospace`, which picks an arbitrary CJK face), and the quadrant colors were defined as
  `--zq-q1bg` / `--zq-q1bd` while **every** consumer wrote `--zq-q1-bg` / `--zq-q1-border` — so
  the four-quadrant tint pills, this product's signature visual, rendered transparent
  (measured `rgba(0,0,0,0)`). `--zq-fontM` deliberately puts a mono family first and the body's
  CJK serif after it: font fallback is **per character**, and JetBrains Mono / Consolas have no
  CJK glyphs, so Latin stays monospaced while Chinese matches the rest of the page.
  `FrontendTokenAndDateTest` fails the build on any dangling `var(--zq-*)`.
- **Calendar dates in the frontend come from `localDate()`, never `toISOString()`.** The latter is
  UTC: between 00:00 and 08:00 CST it yields *yesterday*. That was shipping — the dashboard header
  showed yesterday, routine check-ins recorded `checkDate` as yesterday (breaking the streak), and
  pomodoro study time landed on the previous day. `localDate` is exposed on `window.zqApi` so page
  inline scripts share the one implementation.
- **12 of the 14 pages still ship design-phase demo data** — inline scripts that write a fabricated
  study plan into the DOM *before* `zhiqu-api.js` loads (`dashboard.html` labels its own block
  `// ── 示例数据（后续可由接口替换） ──`). Users never see it, and that rests on exactly one
  thing: when a page's boot function throws, `renderInitError` replaces **all of `.zq-main`**.
  Weaken that to a toast and any failed load — a 429 from the 180/60s rate limit is enough —
  shows the user someone else's goals, weaknesses and pomodoro history as if they were their own.
  `InitErrorReplacesDemoContentTest` pins the replacement, the `renderError: true` on the boot
  call, and that no demo container sits outside `.zq-main`. The demo blocks are tangled with real
  wiring (`paintWd`, `zqPomoRecord`, `openModal` are referenced from inline `onclick`), so
  removing them is a separate job — not a reason to leave the guard unpinned.
- **Cache busting**: every page loads assets with a shared `?v=<token>` and `service-worker.js`
  keys its cache off the same token (`ZHIQU_CACHE = 'zhiqu-shell-v<token>'`). After changing any
  asset, bump the token in **all** HTML files *and* the service worker, otherwise users keep the
  old bundle. Current token: `20260928-display-phone2`.
  `StaticAssetCacheTokenTest` enforces that every `?v=` and `ZHIQU_CACHE` agree — the token is
  a **browser** HTTP-cache buster (the service worker is network-first and matches with
  `ignoreSearch`), so a drifted page silently keeps serving the old bundle.

### AI assistant

- Chat streams over SSE (`POST /api/ai/chat/stream`). **`SecurityContext` does not propagate to the
  async thread**, so tool executors take an explicit `userId`.
- Planning uses OpenAI-style function calling (`create_study_plan`). The gate
  `AgentPlanDecision.taskCreationIntent()` requires **both** a plan word (计划/规划/安排/任务…) **and** a create
  word (生成/创建/制定/添加…); "帮我安排下周任务" alone will not produce a plan.
- A generated plan is **never written to the calendar automatically**. It becomes a DRAFT artifact
  (`PLAN_DRAFT` / `TASK_DRAFT` / `ROUTINE_DRAFT`) plus `ai_message.suggested_plan_json`, and the UI
  auto-opens a confirmation modal (忽略 / 修改 / 确认写入). Only
  `POST /api/ai/artifacts/{id}/confirm` calls `studyTaskService.create/createRepeated`.
  That endpoint takes an **optional** body `{tasks, routines}` — the edited items from the modal —
  which overrides the stored draft; omitting the body applies the draft as-is.
- **Long-term memory is also draft-first.** `MEMORY_CURATOR` produces a `MEMORY_DRAFT` artifact
  (discrete items, tickable); only `POST /api/ai/artifacts/{id}/confirm` merges them into
  `user_ai_memory`. Clearing memory bumps `sys_user.memory_epoch`, and confirming a draft whose run
  predates the bump is refused — see `docs/adr/0002`.
- **Verification is a closed loop, not a notification.** `VERIFIER` (PRE_STREAM, before the answer)
  checks the *evidence*: its findings are injected into the answer prompt as a user-role data block,
  and the one blocking case — user picked sources but zero evidence was retrieved — aborts the turn
  rather than answering from general knowledge as if grounded. `ANSWER_VERIFIER` (POST_STREAM)
  then checks that every citation the model emitted came from evidence we actually fetched;
  anything else is flagged `CITATION_NOT_IN_EVIDENCE`.
- **Every agent that runs has a node in the task graph.** `AgentStageRunner.inGraph` has two
  overrides, both of the same legitimate kind — one runner answering to several node types:
  `RetrieverRunner` to `{CONTEXT_RESEARCHER, WEB_RESEARCHER, RETRIEVER}` (it is the merge point),
  and `ContextResearcherRunner` to `{CONTEXT_RESEARCHER, RETRIEVER}` (it also serves the fallback
  node). "Ran without a node" is now structurally unwritable — before adding a backdoor, ask why
  that agent should be invisible in the execution trace the user can see.
- **A refresh mid-stream does not lose the answer.** The assistant row is created empty
  (`status=STREAMING`) when the stream starts, and `StreamingContentFlusher` writes the
  partial text back every ~1.5s (and once more at the end) via
  `AiMessageMapper.flushStreamingContent`. This is a **second write path** for assistant
  messages, and unlike the final one it runs on the stream thread, outside the user lock and
  outside the transaction — so it does **not** inherit the epoch fence. Its protections live in
  its own `WHERE`: `deleted = 0` (a cleared conversation must not be refilled — ADR-0002) and
  `status = 'STREAMING'` (a late flush must not revert a DONE message to half an answer).
  Returning 0 means *stop flushing*, not *retry*. The frontend picks the rest up by polling
  while any message is `STREAMING` (capped at 5 min, matching `STREAM_TIMEOUT_MS`).
- **Chat history is cursor-paginated.** `GET /api/ai/messages` takes an optional `before=<id>`;
  the UI loads 50 at a time and shows `↑ 加载更早的消息` while a full page came back. Before
  2026-09-20 there was no cursor at all — the UI asked for 50, the service capped at 100, and
  anything older was **permanently unreachable** (not deleted; the rolling summary still fed it
  to the model, but the user could not scroll back to it). The cursor is the message **id**, not
  a timestamp: two messages written in the same millisecond share `created_at`, so a timestamp
  cursor would either skip one forever or return it on every page. When prepending older
  messages the UI anchors on an existing bubble's `getBoundingClientRect().top` rather than a
  `scrollHeight` delta — the delta silently includes the load-more button, which disappears on
  the last page.
- **The chat does not yank the user to the bottom.** It follows only while they are already at
  the bottom (48px slack); once they scroll up it stays put and shows a `↓ 新内容` button.
  Streaming deltas patch **only the streaming bubble** (`patchStreamingMessage`) instead of
  rebuilding the whole list — the old path re-ran `renderMathIn` over the entire chat on every
  token, so each token got more expensive the longer the conversation was.
- **There is no Web Push.** Reminders go through `PUSHPLUS` / `WECOM` / `QQ`
  (`service/notification/`). `service-worker.js` still has `push` / `notificationclick`
  handlers, but nothing calls `pushManager.subscribe()` and there is no sender, so they are
  unreachable — labelled as such in the file. The `app.push.vapid-public-key` key and the
  `ZHIQU_WEB_PUSH_PUBLIC_KEY` row in `deploy/README.md` were retired on 2026-09-20: nothing read
  them, and they led operators to generate a VAPID key pair believing push was wired.
- **Ordering has exactly one authority: `AgentPosition`.** The graph's `priority`,
  `parallelGroupId` and `dependsOn` are **derived** from `AgentStageExecutor.runOrder()`, which is
  why `MultiAgentOrchestrator.plan(...)` takes it as a parameter and the executor is constructed
  *before* the graph is built. Do not hand-write those three — they were hand-written until
  2026-09-20 and all three had gone stale: 8 of 14 nodes had the wrong `priority` (and `listTasks`
  is `orderByAsc(priority)`, so that *is* the order the user reads in the execution trace),
  `RETRIEVER` was labelled into a `"research"` group its runner never joins, and every `dependsOn`
  was `[orchestrator]` — a star, which says nothing. A graph node whose `agentType` has no runner
  now throws at plan time instead of sitting PENDING forever.

### Authorization

Two guards carry almost all of it, and **both are per-method manual calls, not declarative rules** —
`SecurityConfig` has no `hasRole(...)` anywhere, only `anyRequest().authenticated()`.

- **Admin APIs** — every method in `AdminController` calls `requireAdmin()` as its first statement
  (29 of them), which delegates to the single `AdminGuardImpl`. `POST /api/ai/web-fetch/test` is
  guarded the same way but lives outside `/api/admin` (it makes the server fetch a caller-supplied
  URL, so it is admin-only; the SSRF guard restricts the *target*, not the *caller*).
  `AdminAuthorizationTest` pins that every mapping in `AdminController` has the call — before it,
  adding an endpoint and forgetting the line was a hole nothing would catch.
  Note `AdminPageWiringTest` does **not** cover this: it pins the admin *pages* (client-side
  routing and the static whitelist, which is `permitAll`), which is UX, not API authorization.
- **Per-user data** — `ownedNotebook(userId, id)` is the single implementation (the public
  `requireOwnedNotebook` just delegates); every notebook-scoped read/write goes through it or
  through `resolveNotebookId`, which calls it when an id is supplied.
- **Uploaded originals** — `PrivateUploadPathGuard` decides which file on disk may be read.
  The row-level checks above cannot help here: `ai_notebook_source.file_path` is a **string in the
  database**, so one bad write makes it point outside the user's directory while the row still
  legitimately belongs to that user. The guard requires the normalized path to stay under
  `<upload-root>/ai-sources/<userId>`, rejects symlinks (a link *inside* the directory passes the
  prefix check), and requires a regular file. Deleting any one of the three leaves downloads
  working, which is exactly why each has its own judgment. The same class also owns the
  `ai-sources/<userId>` layout used when **writing** — defining it twice would make every stored
  original silently unreadable (downloads fall back to exported text with no error).

### Knowledge Wiki

Pages → revisions → patch sets ("待合入变更"). AI edits land as drafts and only reach a page through
the single guarded entry point `upsertRevisionPage`. Two independent protections:

- **Optimistic lock** — `user_knowledge_page.version` (`@Version`). Write APIs require the client's
  `version`; `reparentByVersion` / `softDeleteByVersion` carry it in the `WHERE`, and
  `updateById(...) != 1` raises `知识页已被其他窗口修改，请刷新后重试`.
- **Draft baseline** — a revision stores `base_content_hash` (title + body) and `base_page_version`
  captured **when the agent read the page**, in memory, from the same text handed to the model.
  Apply is refused if the page changed since, if the draft has no baseline, or if the request tries
  to re-point a bound draft at a different page.

Structure fields (`parentId`/`sortOrder`/`pinned`) are only modified when the request body actually
contains that key — so applying a patch with an empty body never moves a child page to the root.

### Shared plans

Submissions go `PENDING` → `APPROVED` / `REJECTED` / `OFFLINE`. The rejection reason is stored
**twice on purpose** and the two copies are not redundant: `shared_plan_template.rejection_reason`
is the reason for the *current* status (nulled when the plan is not rejected) and
`shared_plan_review.note` is the append-only audit trail (every review ever made). Do not
"clean up" one of them without moving its consumer.

`GET /api/shared-plans/mine` is what makes the admin UI's promise true — the reject dialog says
"驳回原因（可选，将展示给提交者）", and until 2026-09-21 nothing showed it: `publicList` returns
only `APPROVED`, `reviews` appears only in `adminDetail`, and `rejection_reason` had **zero
readers**. Admins wrote careful explanations that went nowhere, and submitters were never told
their plan had been rejected at all.

### 代码工作区（coding agent 的磁盘面，默认关闭）

AI 助手原本只是个「work agent」（排计划、写 Wiki、做检索）。工作区是给它加的读代码能力
——「工程即文件夹」：**不建 `code_project` 表**，没有归属检查、没有乐观锁、没有迁移，
版本由用户自己的 git 管。

**默认是关闭的，而这个默认值本身就是安全边界**（`WorkspaceModeTest.默认必须是关闭的` 钉着它）。
四个档位 `OFF / READ / WRITE / EXEC`（`WorkspaceMode`），`parse()` 对任何认不出来的配置值
**回落到 OFF 而不是就近取一档** —— 把 `mode: ON` 写错成一个不存在的值时，该得到「没开」，
不是「开了个小的」。三档都已实现：READ 读、WRITE 写草稿（确认后落盘）、EXEC 再加执行沙箱。

**档位与根目录现在能从界面切换**（AI 助手页工作区面板的 ⚙，`PUT /api/workspace/settings`），
不必再改 `application.yml`；用户的选择持久化在 `~/.zhiqu/workspace-state.json`
（桌面每次重启新 JVM，不持久化就每次回到 OFF）。文件夹选择器走 `GET /api/workspace/browse`
（只列目录、管理员 + 回环）。**切换绕不过下面三条前提** —— `WorkspaceService.applySettings`
只改「想要什么」，`rebuild` 每次重跑那三条裁决「实际允许什么」，所以公网（非回环）上无论
点到哪、持久化里存的是什么，`effectiveMode` 都还是 OFF。持久化存的是<b>用户选的档位</b>
而非降级结果 —— 把同一份 state 拿到回环机器上，原本想要的档位自动恢复。
`WorkspaceRuntimeToggleTest` 钉住这整条不变量（尤其「非回环上切 EXEC 仍是 OFF」）。

生效还要三个前提**同时**成立，缺一就整体降级到 OFF（`WorkspaceAccess`）：

1. `app.workspace.mode` 不是 OFF
2. `app.workspace.root` 指向一个存在的目录
3. `server.address` 是回环地址

第三条是硬前置：`application.yml` 里只有 `server.port`，服务默认监听所有网卡
（实测 `TCP *:18080 (LISTEN)`）。一个能读你硬盘的服务不能是这个状态。注意
`isLoopback(null)` 与 `isLoopback("")` 都返回 **false** —— 「没配」是最常见的配置，
它必须落在拒绝的一侧，否则默认部署就是敞开的。`configuredMode()` 与 `effectiveMode()`
分开报告，前端才能说清「你配了 EXEC，但因为没绑回环所以实际是 OFF」。

`WorkspaceGuard` 在路径上有六道判定，每道都有各自不同的拒绝理由（`Reason`）：
normalize + `startsWith(root)` 防 `../`、拒绝符号链接、只许普通文件、扩展名白名单、
单文件大小上限、目录条目数上限。**扩展名白名单不是为了安全**（`startsWith` 才是），
是为了别把 `.env` / `.pem` / `id_rsa` 喂进模型上下文；所以列目录时就把不可读的文件
标成不可读，而不是等用户点开才拒绝。

四个 HTTP 端点 `/api/workspace/{status,files,file,search}` **全部要管理员**（`WorkspaceControllerGuardTest` 扫的是「每个 `@*Mapping` 都要调 `requireAdmin()`」，所以新加端点会被自动纳入，不用改判据）。理由不是权限模型，
是这个功能读的是**服务器**的磁盘 —— 多用户部署里，普通用户能读的应该是他自己的东西，
而工作区里没有一个字节属于他。

搜索是**字面量匹配、不接受正则**：这个入口的调用方是模型，而 `(a+)+b` 这类正则在不匹配时
会灾难性回溯，把我们自己的 JVM 跑满几分钟 —— 模型没有恶意也会写出来。三道上限各挡一件事：
`maxSearchFiles` 挡「根目录指错了」、`maxSearchHits` 挡搜 `the` 把模型上下文塞满、
`maxSearchLineChars` 挡压缩过的 .js 单行几十万字符。命中截断时**必须说出来**——
模型把「80 条」当成「一共 80 条」就会给出错误结论。

`CODE_AGENT` 节点的门收在 `AgentPlanDecision.codeIntent(message)`，与既有的
`wikiToolIntent` 并列 —— 不要在实现里另起一个判定，那正是 `RETIRED_DECIDERS` 在防的事。
这个门**会过触发**（「今天写了三小时代码，有点累」同时命中「写」和「代码」），这是
故意的：过触发的代价是白读几个文件，漏触发的代价是用户问代码问题却得到一个没看过代码的
回答。`CodeAgentGateTest.已知会过触发的那一类` 把它钉成了明示的取舍，不是待修的 bug。

**工作区写入（阶段 2）走的是 Wiki 那条已经验证过的路：草稿 → 用户确认 → 落盘。**
模型调 `write_workspace_file` 只产出 `CODE_DRAFT` 工件，磁盘一个字节都不动；
只有 `POST /api/ai/artifacts/{id}/confirm` 才会写。四条纪律各挡一件事：

- **最小权限** —— 写工具只在 `canWrite`（工作区档位允许写 **且** `codeWriteIntent` 成立）
  时才下发。不下发，模型就不会尝试，也不会承诺自己改了文件。写这道门比读那道窄得多
  是刻意的：读过触发只是白读几个文件，写过触发会弹出一个用户没要的确认框，而确认框本身
  就诱导人去点。
- **基线** —— 草稿记下 agent 读到该文件那一刻的内容指纹（SHA-256；`String.hashCode()`
  是 32 位、可构造碰撞，不够）。确认时比对磁盘现状，不符就拒。文件当时不存在则基线是
  `WorkspaceService.ABSENT`，确认时它已存在同样要拒 ——「新建」和「覆盖」是两件事。
- **没读过不许改** —— 对已存在的文件，模型必须先 `read_workspace_file`。没读过就改是
  拿想象中的内容覆盖真实内容。
- **成批要么全写要么全不写** —— `writeAll` 先把每个文件都校验一遍再动手。边校验边写的话，
  第三个文件基线不符时前两个已经落盘，用户看到一条报错却不知道工作目录被改了一半，
  而那一半属于一个他没有完整确认的方案。这**不是事务**（写到一半磁盘满仍会留半批），
  它消掉的是唯一一种可预见的半批。

写盘用「临时文件 + 原子改名」：直接就地写，中途失败会留下一个被截断的源码文件。

**读工作区也要管理员。** `/api/workspace/**` 限了管理员，而 code agent 一度只检查档位 ——
那样普通用户对助手说一句「看看 xxx.java」就绕过了那道门，HTTP 那一侧的限制等于装饰。
判定收在 `AiServiceImpl.workspaceReadableBy(userId)` 一处，`CodeAgentGateTest` 断言
`effectiveMode().allowsRead()` 在全文件只出现一次。

**目录软链曾经能把工作区漏出去。** `normalize()` 是纯字符串运算，不解析软链；而守卫只检查
路径最后一段是不是软链。于是 `root/docs -> /别处` 存在时，`docs/secret.md` 两道检查都通过。
`node_modules/.bin`、`docs -> ../shared` 这类软链在真实项目里很常见。现在
`WorkspaceGuard.containedAfterSymlinks` 用 `toRealPath()` 解开每一段再比，**root 自己也要
realpath** —— 否则 macOS 上 `/tmp` 实际是 `/private/tmp`，正常读取会全部失效。

**执行沙箱（阶段 3）默认关闭，而且它不是你以为的那种沙箱。**
白名单里有 `python3` / `node` / `java`，**允许它们就等于允许任意代码** —— 一段 Python 能删掉
用户的家目录，`WorkspaceExecutor` 拦不住，进程级隔离（容器 / seccomp）不在这一层。
把它叫「沙箱」而不说这一点，会让人以为代码被关住了。

真正的边界是**只能跑用户已经看过的代码**：

- **禁行内代码开关**（`-c` / `-e` / `--eval` / `-i` …）。有了它们，模型可以把任意程序当成
  一个参数传进来，那段代码没有经过任何人的眼睛。禁掉之后执行对象只能是工作区里**已经存在
  的文件** —— 要么用户自己写的，要么走过 `CODE_DRAFT` 的 diff 确认。**这是这一层唯一
  真正意义上的安全判定**，其余几条都只是「炸了也炸不大」。
- 参数不接受绝对路径与 `..`；命令只接受命令名 + 参数数组，不接受任意 shell 字符串。

开启前提在档位之上又加了一条：**生产 profile 一律拒绝**（`spring.profiles.active` 含
`prod`/`production`），与档位一起收在 `WorkspaceExecutor.enabled()` 里 —— 调用方不许复述
那两个条件，`CodeAgentGateTest.不允许执行时不得下发执行工具` 钉着这一点。

四条资源约束，每条都有行为判据（用真进程跑，不 mock）：

- **超时** → `destroyForcibly`。第一版这里是错的：输出是**同步**读的，而 `read()` 要等进程
  退出才返回 `-1`，于是 `sleep 30` 把读循环阻塞 30 秒，`waitFor` 的超时根本轮不到执行。
  源码扫描和 mock 都发现不了，只有真跑一个死循环才会发现。现在读在独立线程上。
- **输出上限** → 截断并**明确标注**。到上限之后要**继续排空并丢弃**，不能 `break`：
  停止读取会让管道写满、子进程卡在 write 上再也退不出去，一个「日志很多但确实成功了」的
  构建会被报成超时。
- **工作目录**在工作区内。
- **不继承父进程环境变量** —— 最容易漏的一条。主进程里有 `ZHIQU_SYSTEM_AI_API_KEY`、
  数据库密码；继承的话用户让 AI「跑一下这个脚本」，一句 `os.environ` 就全拿走，而输出会
  原样回到模型上下文里。`environment().clear()` 之后子进程没有 `PATH`，所以命令名在**父进程**
  那一侧解析成绝对路径再交下去（用父进程的 PATH 去*找*，不等于把它*传下去*）。
  这条判据不维护「良性变量名单」：macOS 的 python3 shim 在 `env -i` 下也会注入
  `CPATH/LIBRARY_PATH/MANPATH/SDKROOT/__CF_USER_TEXT_ENCODING`，手写名单要么把它们当泄漏
  （假红），要么放行它们（换平台就漏掉真泄漏）。判据改成**现场量一次解释器自己的地板**
  再相减，并单独断言子进程的 `PATH` 是我们给的固定值。

执行结果不落库（不建 `code_run` 表）：那是临时诊断信息，不是需要长期保存的资产。

**刷题与判题（阶段 4）没有新实体 —— 它是已有零件的一条环路。**
出题 = `write_workspace_file`（草稿 → 确认落盘）；判题 = `run_workspace_command`；
错题归档 = `create_wiki_patch` 写 `pageType=WEAKNESS`。四步全部复用已验证过的路径，
**不建「错题本」表**。

为此 code agent 拿到了 Wiki 的三个工具，但分两档：

- **读工具（`search_wiki` / `read_wiki_page`）一直给** —— 出题之前先看这个人以前错在哪，
  题才出得准。
- **写工具（`create_wiki_patch`）只在本轮真的跑过一次判题之后才给**（`CodeLoopState.ranCommand`）。
  门开在「跑过没跑过」这个**事实**上，而不是关键词上：关键词会过触发也会漏触发，
  而「这一轮有没有执行过命令」是确定的。为此工具表**每轮重建** —— 一次性算好的话，
  这个条件只能用「用户说了什么」来近似。

Wiki 调用原样交给 `executeWikiTool`，**不在 code 循环里另拼一份**。那条路上有一整套防护，
其中「**未完整读取不许整页覆盖**」对错题归档尤其要紧：薄弱点页是累积的，一次整页覆盖
就把用户以前记的全冲掉了。提示词因此要求先 `read_wiki_page` 读全，再把新的一条追加上去。

**这一阶段最重要的发现是靠实测拿到的，不是靠读代码。** 沙箱、判题、归档全建好之后，
拿十一种真实说法探了一遍 `codeIntent` / `codeWriteIntent` —— **一条都不命中**。
也就是说整条环路建好了而用户永远走不到。于是有了第三道门 `practiceIntent`，两档：
「我的解法」「练习题」「刷题」这类足够具体的词单独成立；「考考我」「出一道」这类通用词
要配一个学科词（算法/递归/二叉树…）或代码名词，否则背单词也会把 code agent 拉起来。

`practiceIntent` 与 `codeIntent` 的 OR 收在 **`codeAgentIntent` 一处**，建图与执行共用。
第一版只改了建图侧，执行侧 `runCodeWorkspaceAgent` 判的还是 `codeIntent` —— 刷题那一轮
图里造出 CODE_AGENT 节点、runner 直接返回空，用户在执行轨迹里看到一个什么也没做的方块。
`CodeAgentGateTest.实现侧只能调用这道门不能另起一套` 现在盯着这一点。

**已知接不住的那一类（明示的取舍）**：「给我出一道题」「跑一下测试看我写对没有」
「复盘一下刚才那道题」。它们缺的不是词而是**上下文** —— 只有在「刚才出过一道题」之后
才说得通，而本仓库所有的门都只看当前这一条消息。`CodeAgentGateTest.已知接不住的那一类`
把它钉住了，免得下一个人当成漏洞往词表里随手塞词。

**项目式引导（阶段 5）同样没有新实体。** 里程碑走的是 PLANNER 那条已有的路：
code agent 在项目语境下拿到 `create_study_plan`（**同一个 schema，不另写**），
产出的 `{tasks, routines}` 放进 `suggestedPlan`，由既有的 `TaskDrafterRunner` 变成
`TASK_DRAFT` / `ROUTINE_DRAFT` 工件，再走既有的确认分支进日历。自己另猜一套字段名的话，
确认落库时会静默丢掉象限、时长、截止日期，而任务照样建出来 —— 没人会发现。

**这条链路原本有两处断点，都不报错：**

1. `needsTaskDraft` 只看 `TASK_DRAFT_WORDS`，项目语境下为假 → 图里没有 TASK_DRAFTER 节点
   → `inGraph` 为假 → runner 不跑。里程碑放进了 `suggestedPlan`，却没人把它变成工件。
2. `PlanExtractorRunner` 在 POST_STREAM **无条件**赋值 `suggestedPlan`，而
   `suggestPlanFromChatIfNeeded` 在非 `taskCreationIntent` 时**必然**返回空计划 ——
   PRE_STREAM 放进去的里程碑在这里被悄悄抹掉。现在的规则是：**空的不许盖掉非空的**。

两处都是「看起来接通、实际永远产不出东西」。

**四道意图门的关系**：`codeIntent`（读/审阅）、`practiceIntent`（刷题）、`projectIntent`
（项目式引导）三者 OR 成 **`codeAgentIntent`**，建图与执行共用这一个表达式。
后两道各自分两档：足够具体的词单独成立，通用词要配一个代码名词或学科词 ——
`带我做` / `分几步` 第一版放在单独成立那档，实测把「带我做一道红烧肉」「分几步走完这个学期」
也拉了进来。**每加一道门都要拿十来条真实说法探一遍**，正例反例一起探。

**第五道门 `buildIntent` 与「代码」开关（2026-09-23）。** 工作区已经在界面切到「读+写+运行」，
用户说「帮我做一个小游戏，放在test文件夹里」，得到「我无法直接操作你的电脑」—— 图里根本没有
CODE_AGENT：读门动作词没有「做」，写门没有「放在」。两层都漏了。修法两半：

- 输入框旁的**「代码」按钮**（`contextOptions.codeMode`，只认字面 `true`，只在工作区生效时出现）。
  按下就不再猜意图、并给写工具；但**绕不过**工作区的回环 / 管理员 / 可读前提。
  `AgentPlanDecision.codeAgentIntent(message, options)` / `codeWriteIntent(message, options)`
  是这个 OR 的唯一出处，建图与执行共用。
- `buildIntent`：造（做一个/写个/生成一个…）+ 成品名词 / 语言名 / 算法词，或造 + 放进文件夹。
  四批四十余条实测说法定的词表，其中三处是**放宽之后实测出来的误伤**再收窄的：裸「目录」
  （「写到复习目录里」）、「存在」（「目录里存在的问题」）、「python 学习计划」一类
  （学习产物词出现时，语言名是学习对象而不是工具）。「那你直接写进去吧」这类追问接不住，
  由按钮兜底 —— 别往词表里塞「写进去」。

同一次还修了三件「看起来接通、实际没用」的事：最终回答原来**无条件**被告知「你这一轮没有写文件的能力」
（草稿弹出来了，回答却说改不了 —— 现在由 `CodeContextPrompt` 按本轮是否有草稿分支）；
显式请求沿用关键词的 4 轮 30 秒预算（写一个完整小游戏做不完 —— `CodeLoopBudget` 分两档，
显式 10 轮 180 秒，且要给最终回答留出一分钟）；工具循环对外只有开头结尾两条事件
（现在每次调用前后各发一条 `agent.step.note`，`CodeToolNarration` 负责说成人话，
网页轨迹与 CLI 读同一份；命令输出进 innerHTML 前必须转义，`step-note-check.js` 用对抗性输出判）。

### 限额边界

`WorkspaceBoundaryTest` 专门钉各处上限的「正好 / 差一 / 多一」。限额处的 off-by-one
是最容易静默出错的一类：功能照常工作，只在某个刚好的尺寸上多拒一个、少拒一个。
写这一批时抓到两个真的：

- **执行输出正好等于上限时被标成「已截断」**（`read >= room` 应为 `>`）。后果不是崩，
  是模型对用户说「还有更多」，然后建议他换个更窄的命令白跑一次。
- **列目录到 `maxEntries` 静默截断**，一个字都不说。600 个文件的目录返回 500 条，
  模型据此说「这个目录有 500 个文件」或者下「这里没有 X」的结论。搜索那边早就报截断了，
  列目录这边漏了 —— 同一条纪律只落实了一半。现在 `listing()` 返回 `{entries, truncated}`，
  控制器、工具层、前端三处都要把它说出来（做出信号却不用，等于没做）。

另外钉住：**上限算的是字节不是字符**。中文一个字三字节，按字符算的话 256KB 的上限
实际变成 768KB，防 OOM 的意义打三折。

**「最小权限」的那几道门原来只管声明、不管执行。** `canWrite` / `canExec` / `ranCommand`
决定把哪些工具<b>声明</b>给模型，而执行侧是<b>按名字分派</b>的 —— 模型（或者一个被注入了
指令的工具返回值）报一个没下发过的名字，照样会被执行。门是建议性的，不是强制的。

这一点单元判据看不到：它们验的是「该不该下发」，而不是「没下发的能不能调到」。
是端到端扰动撞出来的 —— 把写工具改成永不下发，`CODE_DRAFT` 草稿照样产了出来。
现在每一轮先 `offeredToolNames(tools)` 收一份清单，分派前比对，不在清单里就拒绝并
告诉模型「这一轮没有给你这个工具」。**「下发了什么」和「能执行什么」必须是同一份清单。**

`CodeAgentLoopIntegrationTest` 用脚本化的假模型把整条刷题环路真跑一遍
（读文件 → 跑判题 → 记薄弱点 → 生成改动草稿）。其中一条断言是间接的，而这正是它最硬的
地方：「薄弱点草稿存在」<b>证明了命令确实跑过</b> —— `create_wiki_patch` 只在 `ranCommand`
置位之后才下发，拿不到工具就调不出来。

### 拆 AiServiceImpl（进行中）

它曾经 5770 行，混着两类完全不同的东西：**要问模型什么**（业务）和**怎么把请求发出去**
（协议）。第一刀拆的是后者 —— `service/ai/ModelProviderClient`：URL 解析、鉴权头、温度、
超时、OpenAI 与 Anthropic 的差异、错误格式化、SSRF 校验。它不依赖任何业务概念，
也不会被业务改动波及，所以先走；走了之后别的 agent 可以只依赖它，不必再依赖那个大类。
搬了 18 个成员、改了 60 多个调用点，行为判据 439 条全绿。

**第二刀**是知识 Wiki 的工具循环 → `service/ai/WikiToolAgent`：自己的工具声明、执行器、
循环状态，以及一整套只对它有意义的防护（未完整读取不许整页覆盖、保留页、本轮幂等、
按「用户+标题」分桶的进程内条带锁、可信快照）。它现在只依赖 `ModelProviderClient`、
`KnowledgeService` 和 `ObjectMapper`，不再依赖那个大类。

三个被反复用到的文本处理提到 `common/Texts`（`limitCollapsed` / `limitRaw` / `orDefault`），
函数调用的 schema 形状提到 `service/ai/ToolSchemas`。两处都在 `AiServiceImpl` 里留了
一行委托，所以它那 60 多个调用点一个都不用改。

**第三刀**是执行轨迹的写入者 → `service/agent/AgentTraceRecorder`：`startTask` /
`startStep` / `finishStep` / `completeTask` / `skipTask` / `errorStep` 与那几个事件构造器。
这四个方法在 15 个 runner 里被调了 44 次，而它们真正用到 `StreamState` 的只有
`requestId` 和 `agentRun` 两个字段 —— 所以记录器**按一轮构造**、绑定这两样，
调用点不必再把整个 StreamState 递进去。

`artifactStreamSummary`（产物预览长什么样）**没有**跟着搬，而是改由调用方传进来。
轨迹写入者只管「什么时候发生了什么」；一个产物怎么摘要给用户看是展示层的事，
而且它牵着一串只有 `AiServiceImpl` 才有的文本工具。让它反过来依赖那些，这一刀就白拆了。

`AgentTraceCompletenessTest` 钉住这一刀真正保护的东西：**一轮结束时不许留下停在
「进行中」的方块**。`settleUnrunTasks` 必须在成功与失败<b>两条</b>路径上都调一次。
写这条判据时它第一次跑就红了 —— 锚点选错了：`errorRun(` 的第一次出现是「装配窗口」
那个 catch，那里图还没建好、没有节点可收。判据的锚点错了，不是代码缺了收尾。

**第四刀**本来打算整块搬「检索这件事」，量过之后改了主意 —— 这个改主意本身值得记：
三个检索 runner 只有 200 行，却摸了 **22 个 `StreamState` 字段**（写 8 读 14）。
把它们搬出去就得把整个轮次状态一起暴露，用 200 行换一个扛 22 个字段的新抽象 ——
那不是解耦，是把耦合换个地方放。

改成搬它们调用的那批方法：其中 **6 个对轮次状态依赖为零**。
`service/ai/RetrievalPresentation`（149 行）收下 5 个 —— `citationRows`、
`retrievalStatus`、`isSuccessfulCitation`、`withWebSearchContext`、`withNotebookContext`；
`rewriteRetrievalQuery` 留下，因为它要调模型。新类**零字段、零常量、不碰 Spring**，
全是静态纯函数。

**这一刀换到的不是「少了 89 行」，是这 89 行从此不用 mock 就能测。**
它们在 5770 行那个类里时，要测就得立起整个 Spring 上下文，于是一直没人测；
拆出来当天就补了 9 条判据，包括「没有检索结果时提示词一个字都不能变」
（加个空的「参考资料」标题会让模型以为搜过但没搜到，然后为此道歉）
和「抓取失败的条目不得当成资料」（否则模型把错误页面的内容当成检索到的事实）。

搬的过程里发现 `isSuccessfulCitation` **有两个重载**（一个吃 Map、一个吃 SearchResult），
各写了一套、当时语义碰巧一致。合并成一个私有判定，并留下一条判据钉「两个重载对同一
状态必须给出同样答案」—— 挡的不是今天，是将来谁加一个 `PARTIAL` 只改一边：
同一条引用会在提示词里算成功、在前端状态里算失败，两边都不报错。

**第五刀**是 code agent 的工具循环 → `service/ai/CodeWorkspaceAgent`（大类 4992 → 4486 行）。
照第四刀的规矩**先量再搬**：这一块用到 8 个大类字段，全是注入的服务，**0 个 `StreamState` 字段**
（检索 runner 是 22 个）—— 所以能整块搬，形状就是第二刀的 `WikiToolAgent`。搬完之后大类不再依赖
`WorkspaceService` / `WorkspaceExecutor` / `AdminGuard`，「工作区能不能读」只剩 `readableBy` 一处。

和 PLANNER 的接缝是 `CodeWorkspaceAgent.MilestonePlanning`：里程碑必须用 PLANNER **同一份**
`create_study_plan` schema 和解析器，所以它们留在原处，只通过这个窄接口借出去。
`MilestonePlanning.of(schema, parser, usable)` 顺带改掉一个行为：PLANNER 的解析器对坏 JSON 抛异常，
搬家前它会冲出工具循环、让整轮提前结束；现在变成回模型一句「参数不对」，循环继续。
Wiki 的工具名也收成了一份（`WikiToolAgent.TOOL_NAMES`）—— code agent 原来手写了一份，
旁边注释「与 buildWikiTools 保持一致」，靠注释维持的一致就是第二份真相。

**搬家时判据怎么跟着走**（这次照「扫错文件的判据看起来和通过一模一样」逐条处理的）：每条判据读
**它那条性质现在住的文件**；`assertFalse` 类的**两个文件都查**（只查旧文件的话，代码一搬走它自动变绿）；
计数类要求新文件 `== 1`、旧文件 `== 0`。扰动 S9 往**新**文件里塞了一个另起的意图判定，
改过指向的 `assertFalse` 红了 —— 这一步证明它真的在看新文件。

换到的东西和第四刀一样：这个循环**第一次能真跑着测**。以前它的几道门只有扫源码的判据（钉写法、
钉不住行为），现在 `CodeWorkspaceAgentTest` 拿脚本化的假模型喂越权调用、没读过就改、坏的里程碑参数。
其中一条被扰动照出是弱的：拿掉「没下发就拒绝」之后「不产草稿」那半条照样绿 ——
假工作区对那个文件返回 null，被「没读过不许改」**另一道门**顶替了。改成真正的新文件（`ABSENT`）之后
两半断言各自能红。**一个断言绿着，可能是因为别的防护替它挡了。**

**第六刀**是 `create_study_plan` 这个工具 → `service/ai/StudyPlanTool`（schema、解析器、`hasContent`；
大类 4486 → 4256 行，不再依赖 `ReminderPlanService`）。同样先量：8 个方法只用到时钟、提醒服务、
ObjectMapper，0 个轮次状态字段。第五刀那个 `MilestonePlanning` 接缝只因为解析器住在大类里才需要；
它有了自己的家，code agent 直接依赖它，接缝和大类里的适配器一起删了 —— **接缝是为了当时的约束而存在的，
约束没了它就该走**。

这一刀多做了一步：**先拍金样再搬家**。搬之前用反射调大类里原来的私有方法（时钟固定、提醒服务打桩），
把 schema 和一组边界输入的解析结果写进 `src/test/resources/golden/study-plan-tool.json`；
`StudyPlanToolTest` 拿新类的输出按 JSON 树逐项比。于是「搬家不改行为」是验证过的，不是口头保证的 ——
扰动时它连「提醒偏移排序反了」「默认结束日期差一天」都抓到了。

新判据第一次跑就报了一个「第二份 schema 声明」在 `AiServiceImpl` 里 —— 查下来是**误报**
（命中了 tool_choice 的 `Map.of("name", "create_study_plan")`），但它照出了真问题：工具名的字面量散在
四个文件共 7 处。改了声明漏了别处，tool_choice 强制一个不存在的工具、按名字匹配的地方永远匹配不上，
计划静默地产不出来。现在是 `StudyPlanTool.NAME` 一份，判据改成最朴素的「去掉注释后字面量全仓只出现一次」。
**误报也要查到底**：这一次误报的原因本身就是个真 bug。

**再下一刀不该是「把 15 个 runner 搬出去」。** 它们剩下的耦合是各自的<b>领域工作</b>
（检索、校验、摘要、计划解析），而那些方法就是 `AiServiceImpl` 的其余部分。
只搬 runner 外壳会得到 15 个小文件、每个都反过来伸手进大类 —— 比现在更糟。
该搬的是<b>纵切</b>：把「检索这件事」（retriever + context researcher + web researcher
及其助手）整块搬走，runner 跟着走。

**搬家会让判据扫错文件，而扫错文件的判据看起来和通过一模一样。** 第二刀之后
`CodeAgentGateTest` 那条「`createPatchSet` 只许有一处调用」还在扫 `AiServiceImpl`，
而方法已经搬走、计数变成 0，`assertFalse(contains(...) && count > 1)` 于是**真空通过**。
它是绿的，但它什么也没看。现在改成扫 `WikiToolAgent` 并断言 `== 1`（而不是「不超过 1」）——
**给计数类判据一个正数下限**，是这一类真空绿唯一的解药。

`WikiToolGuardTest` 用反射调那个内部判定，搬家后直接红（「无法调用生产判定方法」）。
反射的代价就是编译器帮不上忙，只能靠判据在运行时红 —— 这次它尽到了职责。

**这次搬家照出了一个既有的 SSRF 洞。** 写 `ModelProviderSsrfGuardTest` 时它第一次跑就红了，
查下来<b>五个真正发出站请求的方法没有校验</b>：视觉路径（`analyzeImage` 是
`AiController` 暴露的真实端点）、两条流式路径、Anthropic 的计划工具调用。
模型 API URL 是用户自己填的 —— 他填 `http://169.254.169.254/latest/meta-data/`，
服务器就替他去读云元数据，而返回内容会显示在「测试连接」的结果里。

修法是把校验放在<b>真正发请求的那一层</b>，不是放在调用方：放调用方就总会有人忘，
而且新增一个调用方就多一个口子。判据现在钉的是这条不变量本身 ——
凡是出现 `postForEntity` / `.exchange(` 的方法，同一个方法体里必须先出现校验。

### RAG (optional)

`app.rag.enabled` defaults to **true** (`${ZHIQU_RAG_ENABLED:true}` in `application.yml`). When the
sidecar is unreachable the backend **degrades to keyword retrieval on its own** — so a missing
sidecar makes retrieval weaker, not broken. Pass `--app.rag.enabled=false` to skip it explicitly.

The sidecar is a local Python service (`rag-service/`, `127.0.0.1:8001`, bearer
`app.rag.service-token`). **Start/verify/stop instructions for Windows, macOS and Linux are in
`rag-service/README.md`** — including the two things that are easy to get wrong: the health
endpoints are `/health/live` and `/health/ready` (not `/healthz`), and **both require the bearer
token** like every other endpoint. `GET /v1/meta` is what to read when versions look mismatched.

### Auth flow

1. `POST /api/auth/login` → `{ code: 200, data: { token, ... } }` → stored in `localStorage.token`.
2. Every request sends `Authorization: Bearer <token>`.
3. `JwtAuthenticationFilter` populates `SecurityContext`; services scope data by `getCurrentUserId()`.

## Configuration

`zhiqu-backend/src/main/resources/application.yml` (production template:
`deploy/windows/application-prod.example.yml`):

- Database — `spring.datasource.*` (default DB `zhiqu_db`)
- Redis — `spring.data.redis.*` (rate limiting, locks)
- JWT — `jwt.secret`, `jwt.expiration`
- Uploads — `app.upload-dir`
- Timezone — `app.timezone` (default `Asia/Shanghai`). **"Which calendar day is it" is decided in
  exactly one place**, `BusinessClock.today()`. Before 2026-09-21 there were two: the AI prompts
  used `LocalDate.now(ZoneId.of("Asia/Shanghai"))` ("今天是 %s，时区是 Asia/Shanghai", and the
  model dates its tasks from that), while the dashboard's "today", routine check-ins and routine
  scheduling used a naked `LocalDate.now()` — the **JVM default**, which this repo pins nowhere
  (no `-Duser.timezone`, no `TimeZone.setDefault`, nothing in the deploy docs; the JDBC
  `serverTimezone` governs the driver, not the JVM). On a UTC host — the Docker default —
  between 00:00 and 08:00 CST the AI says "today is the 21st" and creates tasks dated the 21st
  while the dashboard filters for the 20th, check-ins record the 20th, and the streak breaks.
  `BusinessClockTest` fails the build on any naked `LocalDate.now()` or hardcoded `ZoneId.of`
  in `src/main/java`, and on the two `@Scheduled(zone = ...)` drifting from `DEFAULT_ZONE`
  (an annotation cannot read config, so that agreement can only be pinned by a judgment).
  `LocalDateTime.now()` audit stamps are deliberately left alone — they only need to agree with
  each other inside one JVM.
- Encryption — `app.crypto.master-key`. **Changing it makes existing ciphertext (AI keys, Wiki page
  bodies) undecryptable.** `SensitiveCryptoService.maskSecret` is what the UI shows instead of a
  key; it reveals **only the last 4 characters**, and nothing at all below 12. It used to show
  `first-6 + **** + last-4`, whose two halves **overlap** at lengths 9–11 — `"0123456789"` came
  out as `"012345****6789"`, the whole secret with a `****` wedged into the middle. Whether a
  value *is* a mask is decided by `isMasked` (prefix check) and nowhere else: the write path used
  to test `endsWith("****")`, which the old format never satisfied for a real key, so that
  "client echoed the masked value back" guard did nothing. Masking is display-only — model calls
  go through `decryptedApiKey`.
- Context window — per model, `ai_model_config.context_window_tokens` (V35, nullable, 8000–1000000).
  `ContextBudget.forWindow` turns it into every size limit that decides what reaches the model
  (history messages + chars, workspace code, coding-agent history, Wiki context). **Unset means the old
  constants exactly** (`ContextBudget.DEFAULT`) — that is the only reason existing chats are unaffected.
  History is trimmed by chars after the count; "trimmed" also counts as window-full, otherwise the
  trimmed messages never reach the rolling summary and silently vanish.
- AI — `app.ai.*`; keys come from env (`ZHIQU_SYSTEM_AI_API_KEY`, `ZHIQU_WEB_SEARCH_API_KEY`).
  Keep `app.ai.web-fetch.block-private-network=true` (SSRF guard).
- RAG — `app.rag.*`

Never commit real API keys; they are injected via environment variables.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `3435986347-spec/zhiqu-StudySystem`, driven via the `gh` CLI.
See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, used verbatim as label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.
