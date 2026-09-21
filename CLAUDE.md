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
`V1` … `V34`). Migrations run automatically on startup — do **not** apply `schema.sql` by hand.
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

Integration tests need Docker (Testcontainers). Without it they skip silently — `Tests run: N,
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

**前端行为判据跑在 node 上，而不是在 Java 里重写一份。** `CodeHighlightEscapeTest` 调用
`src/test/resources/js/highlight-check.js`，后者直接加载 `assets/zhiqu-api.js` 里发布的那份
实现来喂对抗性输入。重写一份 Java 版就成了「测试一个副本」—— 副本绿了不代表线上那份对，
而且两边迟早分叉。没有 node 的机器上它**显式失败并说明原因**，node 装在非标准位置用 `-Dzhiqu.nodePath=<绝对路径>` 指过去；确实没有 node 又要构建，
要跳过得写明 `-Dzhiqu.skipNodeTests=true`，和 Docker 那批的 `-Dzhiqu.skipDockerTests=true`
同一个约定。

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

## Architecture

### Backend (`zhiqu-backend/src/main/java/com/zhiqu/`)

- **`common/`** — `Result<T>` (`code/message/data`), `BusinessException`, `GlobalExceptionHandler`.
  All controllers return `Result<T>`; business errors come back as HTTP 200 with `code != 200`,
  so the frontend must check `result.code === 200`.
- **`security/`** — Stateless JWT. `JwtUtils` signs/parses (subject = userId), `JwtAuthenticationFilter`
  reads `Authorization: Bearer <token>`, `SecurityUtils.getCurrentUserId()` scopes every query.
  `RateLimitFilter` throttles per IP: auth 12/60s, `/api/ai/**` 40/60s, other `/api/**` 180/60s
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
JVM 作为子进程，页面无边框铺满窗口。另有 `package-macos.sh`（jpackage 版）会弹系统浏览器。

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
  old bundle. Current token: `20260921-wiki-tabs`.
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
不是「开了个小的」。目前只有 READ 真正实现。

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
