# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**知趣·象限自主学习系统** — A web-based learning dashboard based on the four-quadrant time management method (Eisenhower Matrix), targeting college students. The frontend is embedded as static files inside the Spring Boot JAR, so there is **no separate frontend build step**.

## Commands

### Database Setup (run once, in order)
```bash
mysql -u root -p zhiqu < zhiqu-backend/src/main/resources/db/schema.sql
mysql -u root -p zhiqu < zhiqu-backend/src/main/resources/db/data.sql
```

### Run (development)
```bash
cd zhiqu-backend
mvn spring-boot:run
```
Access at `http://localhost:8080`.

### Build (production JAR)
```bash
cd zhiqu-backend
mvn clean package -DskipTests
java -jar target/zhiqu-backend-0.0.1-SNAPSHOT.jar
```

## Architecture

### Backend (`zhiqu-backend/src/main/java/com/zhiqu/`)

- **`common/`** — Unified response wrapper (`Result<T>` with `code/message/data`), `BusinessException`, and `GlobalExceptionHandler`. All controllers return `Result<T>`; the frontend checks `result.code === 200`.
- **`security/`** — Stateless JWT auth. `JwtUtils` signs/parses tokens (subject = userId). `JwtAuthenticationFilter` extracts the token from `Authorization: Bearer <token>` and sets `SecurityContext`. `SecurityUtils` retrieves the current userId from `SecurityContext`.
- **`config/`** — `SecurityConfig` (JWT filter chain, whitelist for static assets and `/api/auth/**`), `CorsConfig`, `WebMvcConfig` (static resource handler for `/uploads/**`), `MyBatisPlusConfig`.
- **`controller/`** → **`service/`** → **`mapper/`** — standard layered architecture. Controllers are thin; business logic lives in service impls.
- **`entity/`** — `SysUser`, `StudyTask`, `StudyRecord`, `AchievementDef`, `UserAchievement`. MyBatis-Plus handles soft delete via `deleted` field (0/1).

### Frontend (`zhiqu-backend/src/main/resources/static/`)

- **No build toolchain** — pure HTML + CSS + JS, served directly by Spring Boot.
- **`js/common.js`** — Loaded on every page. Provides:
  - `api` object (`api.get/post/put/delete/upload`) — all calls are prefixed with `/api`, JWT token auto-attached from `localStorage.token`, 401/403 redirects to `/index.html`.
  - `checkAuth()` — redirect guard called at top of every authenticated page.
  - `renderNavbar(containerId)` — injects the shared nav bar including theme toggle.
  - `toggleTheme()` — switches `pixel-theme` CSS class on `<body>` and persists to `localStorage.theme` without page reload.
  - Shared helpers: `showToast`, `formatDateTime`, `quadrantLabel`, `statusLabel`, `priorityLabel`, etc.
- **`css/pixel-theme.css`** — Pixel art theme overrides; applied by adding `pixel-theme` class to `<body>`.
- **`js/pomodoro.js`** — Pomodoro timer logic, used in `dashboard.html`. On completion it calls `/api/record` to write a study record automatically.

### Key Data Relationships

- Tasks (`StudyTask`) belong to a user, categorized by `quadrant` (1–4) and `status` (0=待办, 1=进行中, 2=已完成), with optional `priority` (0–3).
- Study records (`StudyRecord`) are created by the Pomodoro timer and drive all statistics.
- Achievements (`AchievementDef`) are pre-seeded via `data.sql`; `UserAchievement` tracks which ones a user has unlocked. Achievement checks are triggered on login, task completion, and record creation — also manually via `POST /api/achievement/check`.

### Auth Flow

1. `POST /api/auth/login` → returns `{ code: 200, data: { token, ... } }` → stored in `localStorage.token`.
2. Every subsequent request sends `Authorization: Bearer <token>`.
3. `JwtAuthenticationFilter` validates and populates `SecurityContext`; `SecurityUtils.getCurrentUserId()` is used in all services to scope data to the logged-in user.

## Configuration

Edit `zhiqu-backend/src/main/resources/application.yml`:
- Database: `spring.datasource.url/username/password` (default DB name is `zhiqu_db`)
- JWT: `jwt.secret` (change in production), `jwt.expiration` (ms, default 24 h)
- Uploads: `app.upload-dir` (relative to JAR working directory, default `uploads/`)
