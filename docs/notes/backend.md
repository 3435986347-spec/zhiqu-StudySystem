# 后端：包、启动期密钥守卫、权限、RAG、登录流程

> 原来是 `CLAUDE.md` 里的「Architecture → Backend」「启动期密钥守卫」「Authorization」「RAG (optional)」「Auth flow」，第三十八轮（方案第 5 步，`CLAUDE.md` 瘦身）原样挪到这里，一字未改。
> `CLAUDE.md` 现在只留规矩；这里是来龙去脉和细节。文中「上面」「下面」指的是原来 `CLAUDE.md` 里的位置。

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

### 启动期密钥守卫

生产由 `--spring.config.location=file:./application-prod.yml` 拉起，它是**替换**而非追加，
所以 JAR 里的 `application.yml` 线上根本不读 —— 唯一现实的失手是照模板抄一份、
`CHANGE_ME_` 忘了填。而两个占位符都长到能通过 `SensitiveCryptoService` 的 `length() < 24`，
服务会干净地起来并用一个公开在仓库里的字符串签发登录令牌。`StartupSecretGuard` 三条判定：
空（一律拒）、`CHANGE_ME` 前缀（一律拒，开发机也拒）、仓库里的开发默认值（仅生产 profile 拒）。
覆盖哪些键不靠记性 —— `StartupSecretGuardTest` 扫模板里每个 `CHANGE_ME` 行反查。

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
