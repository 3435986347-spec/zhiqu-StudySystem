# AGENTS.md

Guidance for coding agents working in this repository.

> **`CLAUDE.md` is the full, authoritative architecture reference.** This file keeps the
> commands and the gotchas that most often waste time. When the two disagree, trust `CLAUDE.md`.

## Project Overview

**知趣·象限自主学习系统** — A learning system for college students built on the four-quadrant
(Eisenhower) method, extended with an AI assistant, a personal Knowledge Wiki, and optional
semantic retrieval (RAG). The frontend is plain HTML/CSS/JS served from inside the Spring Boot
JAR — there is **no frontend build step**.

## Commands

### Database

Schema is managed by **Flyway** (`zhiqu-backend/src/main/resources/db/migration`, `V1` … `V32`)
and migrates automatically on startup. Do **not** run `schema.sql` / `data.sql` by hand — that is
the old pre-Flyway flow and will not produce a current schema. Only create the database:

```sql
CREATE DATABASE zhiqu_db DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_general_ci;
```

New migrations: next free `V<n>__description.sql`, additive only (nullable columns / new tables).

### Run and build

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

Access at `http://localhost:8080`. Stop it **by port, never by name** — `pkill -f java` will take
down unrelated JVMs including your IDE's:

```bash
kill $(lsof -nP -iTCP:8080 -sTCP:LISTEN -t)                                            # macOS / Linux
```
```powershell
Stop-Process -Id (Get-NetTCPConnection -LocalPort 8080 -State Listen).OwningProcess    # Windows
```

### RAG sidecar (optional)

`app.rag.enabled` defaults to **true**; when the sidecar is down the backend degrades to keyword
retrieval on its own. Start/verify/stop steps for all three platforms are in `rag-service/README.md`.
Two things that waste time: health is `/health/live` + `/health/ready` (not `/healthz`), and
**both need the bearer token**.

### macOS: do not move this checkout back into iCloud

Until 2026-09-21 the checkout lived under `~/Desktop/知趣·象限/`, which iCloud syncs. iCloud
dropped conflict copies (`X 2.class` into `target/`, `AiServiceImpl 2.java` into `src/`) and
Spring's classpath scan then threw `BeanDefinitionStoreException` or stalled with
`IOException: Operation timed out` — a 20-second run spent 5+ minutes in the scan alone.
It reads like a code problem and is not.

It now lives at `~/Developer/zhiqu-quadrant/zhiqu-StudySystem`: outside the Desktop/Documents
sync, and ASCII-only. Keep it there. `SourceTreeCleanlinessTest` still fails the build on any
`* <n>.<ext>` under `src/` — cheap insurance, and static-asset copies are silent otherwise.

### Tests

```bash
cd zhiqu-backend
mvn -o test                                  # offline
mvn -o test -Dtest=WikiToolGuardTest         # one class
mvn -o clean test                            # REQUIRED after any public signature change
```

Integration tests need Docker (Testcontainers). Without it they skip silently —
`Tests run: N, Skipped: N` is **not** a pass. Use `-Dzhiqu.skipDockerTests=true` to make the
skip explicit.

**A new assertion does not count until it has been seen red**, and a red run is not automatically
a working judgment: check whether it failed under `Failures` or `Errors`. `Failures` means an
assertion spoke. `Errors` usually means the context or environment collapsed and the assertion
never ran — that proves nothing. It is the mirror image of "an empty scan looks like a clean one".

## Gotchas that cost time

- **`mvn spring-boot:run` works again** (re-verified 2026-09-21 from the new path). It used to
  fail with `Could not find or load main class com.zhiqu.ZhiquApplication` because the repo path
  contained CJK characters; the move to `~/Developer/zhiqu-quadrant/` retired that.
- **`static/js/*.js` is dead code — no page loads it.** The live application shell is
  `static/assets/zhiqu-api.js` (all 14 HTML pages load it). Editing `js/` has no runtime effect.
- **Bump the asset cache token after any frontend change**, in every HTML file *and*
  `service-worker.js` (`ZHIQU_CACHE`), or users keep the stale bundle.
  Current token: `20260921-wiki-tabs`.
  `StaticAssetCacheTokenTest` fails if any page drifts from the service worker's `ZHIQU_CACHE`.
- **Rate limiting is on by default** (`RateLimitFilter`): auth 12/60s, `/api/ai/**` 40/60s, other
  `/api/**` 180/60s → HTTP 429. Scripted E2E runs that register many users will trip it.
- **SSE chat runs on an async thread where `SecurityContext` is not propagated** — pass `userId`
  explicitly into tool executors.
- **Knowledge page writes require the client's `version`** (optimistic lock). Omitting it returns
  `缺少知识页版本，请刷新后重试`; a stale value returns `知识页已被其他窗口修改，请刷新后重试`.
- **AI-generated plans never auto-write to the calendar.** They become DRAFT artifacts and are
  applied only via `POST /api/ai/artifacts/{id}/confirm` (optional body `{tasks, routines}` carries
  the user's edits from the confirmation modal).
- **Never commit real API keys.** They are injected via environment variables
  (`ZHIQU_SYSTEM_AI_API_KEY`, `ZHIQU_WEB_SEARCH_API_KEY`, …).
- **Maven 可能跑在和 `java` 不同的 JDK 上。** 2026-09-21：Homebrew 把 `mvn` 的 JVM 换成了
  openjdk 26（命令行 `java -version` 仍是 Temurin 17，所以看不出来）。JDK 23+ 默认关闭
  隐式注解处理，Lombok 被静默跳过 —— 一次代码改动都没有，`mvn compile` 却 200 个
  「找不到符号 getXxx()」。`pom.xml` 现在把 Lombok 写进 `annotationProcessorPaths`，
  但构建仍应在 17 上跑：`export JAVA_HOME=$(/usr/libexec/java_home -v 17)`。
  先看 `mvn -version` 的 Java version，再怀疑代码。
- **`-Dtest=A+B` 不是多类语法，用逗号。** 写成 `+` 时 surefire 一条都不跑，
  却报 BUILD SUCCESS —— 典型的空扫假绿。
- **Never change `app.crypto.master-key` casually** — existing ciphertext (AI keys, Wiki page
  bodies) becomes undecryptable.

## Where things live

- Backend: `zhiqu-backend/src/main/java/com/zhiqu/` — `common/`, `security/`, `config/`,
  `controller/ → service/ → mapper/`, `entity/`, `rag/`
- Frontend: `zhiqu-backend/src/main/resources/static/` (`assets/` = live, `js/` = legacy)
- Migrations: `zhiqu-backend/src/main/resources/db/migration/`
- Optional RAG sidecar: `rag-service/` (Python, `127.0.0.1:8001`)
- Deployment: `deploy/README.md` → `deploy/windows/README.md`

## Configuration

`zhiqu-backend/src/main/resources/application.yml`; production template at
`deploy/windows/application-prod.example.yml`. Key groups: `spring.datasource.*`,
`spring.data.redis.*`, `jwt.*`, `app.upload-dir`, `app.crypto.master-key`, `app.ai.*`, `app.rag.*`.
