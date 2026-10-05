# 开发环境：概述、命令、计划入口

> 原来是 `CLAUDE.md` 里的「Project Overview」「Commands」（Database、Run，含 iCloud 那段历史）「进行中的计划」「Agent skills」，第三十八轮（方案第 5 步，`CLAUDE.md` 瘦身）原样挪到这里，一字未改（只把「进行中的计划」里两个链接的相对路径改成从这里出发）。
> `CLAUDE.md` 现在只留规矩；这里是来龙去脉和细节。文中「上面」「下面」指的是原来 `CLAUDE.md` 里的位置。

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**知趣·象限 AI 办公助手** — a personal AI office assistant built around the four-quadrant
(Eisenhower) method, with a personal Knowledge Wiki and optional semantic retrieval (RAG).
Until 2026-10-04 it was a learning system for college students; the rename reached the UI, the AI's
system prompts and the seed data in round 26 (`docs/rounds/round-26.md`) — internal names
(`StudyTask`, `study_record`, `create_study_plan`) were deliberately left alone. The frontend is plain HTML/CSS/JS embedded as static files
inside the Spring Boot JAR, so there is **no separate frontend build step**.

## Commands

### Database

The schema is managed by **Flyway** (`zhiqu-backend/src/main/resources/db/migration`, currently
`V1` … `V43`). Migrations run automatically on startup — do **not** apply `schema.sql` by hand.
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

## 进行中的计划

**产品方案（2026-10-03）见 [`docs/product-plan.md`](../product-plan.md)**：定位从「学生学习系统」改成「AI 办公助手」（用户定的），
五步按顺序做（走主流程 → 删 → 定位落地 → 前端拆模块 → 本文件瘦身），标「要你定」的先问用户。

**zhiqu harness（P0–P7）见 [`docs/zhiqu-harness-plan.md`](../zhiqu-harness-plan.md)**。用户要求全部都做、严格按表执行、
不擅自增删；每完成一项更新那份文件的「进度」列。npm 发布（P7）前必须单独问用户。

## Agent skills

### Issue tracker

Issues live as GitHub issues in `3435986347-spec/zhiqu-StudySystem`, driven via the `gh` CLI.
See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, used verbatim as label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.
