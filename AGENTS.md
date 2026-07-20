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

Schema is managed by **Flyway** (`zhiqu-backend/src/main/resources/db/migration`, `V1` … `V26`)
and migrates automatically on startup. Do **not** run `schema.sql` / `data.sql` by hand — that is
the old pre-Flyway flow and will not produce a current schema. Only create the database:

```sql
CREATE DATABASE zhiqu_db DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_general_ci;
```

New migrations: next free `V<n>__description.sql`, additive only (nullable columns / new tables).

### Run and build

```bash
cd zhiqu-backend
mvn clean package -DskipTests
java -jar target/zhiqu-backend-0.0.1-SNAPSHOT.jar
```

Access at `http://localhost:8080`.

### Tests

```bash
cd zhiqu-backend
mvn -o test
mvn -o test -Dtest=WikiToolGuardTest
```

## Gotchas that cost time

- **`mvn spring-boot:run` does not work here.** The repo path contains CJK characters and the
  plugin fails with `Could not find or load main class com.zhiqu.ZhiquApplication`. Package the
  JAR and run it with `java -jar`.
- **`static/js/*.js` is dead code — no page loads it.** The live application shell is
  `static/assets/zhiqu-api.js` (all 14 HTML pages load it). Editing `js/` has no runtime effect.
- **Bump the asset cache token after any frontend change**, in every HTML file *and*
  `service-worker.js` (`ZHIQU_CACHE`), or users keep the stale bundle.
  Current token: `20260720-plan-confirm`.
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
