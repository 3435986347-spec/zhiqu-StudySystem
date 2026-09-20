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
`V1` … `V33`). Migrations run automatically on startup — do **not** apply `schema.sql` by hand.
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

> `mvn spring-boot:run` fails in this checkout (`Could not find or load main class
> com.zhiqu.ZhiquApplication`) because the repository path contains CJK characters.
> Always package first and run the JAR.

> **macOS only, and it bites hard:** this checkout lives under `~/Desktop`, which iCloud syncs.
> iCloud drops conflict copies named `X 2.class` into `target/`, and Spring's classpath scan then
> throws `BeanDefinitionStoreException` (or stalls on placeholder files with
> `IOException: Operation timed out`) — it reads like a code problem but is not. `mvn clean` may
> even fail to delete `target`. Before any long run: `rm -rf target` (repeat if it says
> "Directory not empty"). The permanent fix is moving the repo out of `~/Desktop`, which would
> also retire the CJK-path caveat above.

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

## Architecture

### Backend (`zhiqu-backend/src/main/java/com/zhiqu/`)

- **`common/`** — `Result<T>` (`code/message/data`), `BusinessException`, `GlobalExceptionHandler`.
  All controllers return `Result<T>`; business errors come back as HTTP 200 with `code != 200`,
  so the frontend must check `result.code === 200`.
- **`security/`** — Stateless JWT. `JwtUtils` signs/parses (subject = userId), `JwtAuthenticationFilter`
  reads `Authorization: Bearer <token>`, `SecurityUtils.getCurrentUserId()` scopes every query.
  `RateLimitFilter` throttles per IP: auth 12/60s, `/api/ai/**` 40/60s, other `/api/**` 180/60s
  (429 `请求过于频繁`). Worth remembering when scripting E2E tests — creating many users trips it.
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

### Frontend (`zhiqu-backend/src/main/resources/static/`)

- **`assets/zhiqu-api.js` is the live application shell** — all 14 HTML pages load it. It owns the
  `api` wrapper, auth guard, navigation, the Wiki UI, the AI assistant UI, agent panels and the
  shared modal helper `openModal({title, bodyHtml, width, onMount}) → {close, body, mask}`.
  `assets/zhiqu-ui.js` / `assets/zhiqu-ui.css` provide the shell chrome and design tokens
  (`var(--zq-*)`).
- **`js/*.js` is legacy and is loaded by zero pages.** Do not "fix" behaviour there expecting it to
  take effect — change `assets/zhiqu-api.js` instead.
- **Cache busting**: every page loads assets with a shared `?v=<token>` and `service-worker.js`
  keys its cache off the same token (`ZHIQU_CACHE = 'zhiqu-shell-v<token>'`). After changing any
  asset, bump the token in **all** HTML files *and* the service worker, otherwise users keep the
  old bundle. Current token: `20260920-history-paging`.
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
- Encryption — `app.crypto.master-key`. **Changing it makes existing ciphertext (AI keys, Wiki page
  bodies) undecryptable.**
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
