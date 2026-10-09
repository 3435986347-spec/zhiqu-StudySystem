# 前端

> 原来是 `CLAUDE.md` 里的「Frontend」，第三十八轮（方案第 5 步，`CLAUDE.md` 瘦身）原样挪到这里，一字未改。
> `CLAUDE.md` 现在只留规矩；这里是来龙去脉和细节。文中「上面」「下面」指的是原来 `CLAUDE.md` 里的位置。

### Frontend (`zhiqu-backend/src/main/resources/static/`)

- **`assets/zhiqu-api.js` is the shared layer** — all 14 HTML pages load it. Since step 4 of the product plan
  (rounds 30–37) it owns only what every page needs: the `api` wrapper, auth guard and shared login, the business
  clock, drafts, page reminders, the pomodoro (one shared clock + its outbox, round 49), the task form, Markdown rendering, the settings-dialog router,
  and the shared modal helper `openModal({title, bodyHtml, width, onMount}) → {close, body, mask}`. Each page's
  code is an ES module in `assets/pages/` (AI assistant, Wiki, dashboard, tasks, routines, statistics, shared plans,
  admin), loaded by `route()` through `PAGE_MODULES` — see the page-modules bullet below.
  `assets/zhiqu-ui.js` / `assets/zhiqu-ui.css` provide the shell chrome and design tokens
  (`var(--zq-*)`).
- **The old `js/` and `css/` folders were deleted on 2026-10-04** (33 files, 22,346 lines, loaded by zero pages but
  shipped in the JAR). Twice a feature existed only there and so worked for no one: the reminder-channel credential UI
  (fixed 2026-09-21) and the Wiki pending-change review (fixed 2026-10-03). `static/vendor/` (KaTeX, DOMPurify, Vditor)
  is live and stays.
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
- **Settings and achievements are dialogs, and the first ES module** (round 30, `docs/rounds/round-30.md`). The avatar at the
  bottom of the sidebar opens a menu (`openUserMenu` in `zhiqu-ui.js`); 设置 / 成就 are links to `#settings/<tab>` and
  `#achievements`, which the shell opens on any page (`watchDialogs` / `syncDialog`) — refresh keeps the tab, Back closes a
  dialog opened from the menu, closing a directly-loaded one strips the hash, switching tabs uses `replaceState`. The code is
  `assets/settings.js`, `import()`-ed on first open with the shell's own `?v=` (taken from `document.currentScript`); it uses
  only what `zqShared` gives it and looks up elements inside the dialog only (`SettingsDialogTest` checks both). Dialog grids
  say how they lay out on a phone with `zq-phone-1col` / `zq-phone-2col` — the `[style*=…]` phone rules only reach `.zq-main`.
  `profile.html` / `achievement.html` are redirect stubs kept for old bookmarks and for `profile.html#harness=…` links printed
  by older CLIs; the server now hands out `/ai-assistant.html#settings/cli?harness=…`, and the login redirect carries that hash.
- **Page modules** (round 31, `docs/rounds/round-31.md`; step 4 continues page by page). A moved page lives in
  `assets/pages/<name>.js`, exports `boots[<page>.html](zqShared)`, and is listed in the shell's `PAGE_MODULES`; `route()` imports
  it through `loadModule` (same `?v=`, loaded once, a user-facing error when it can't load, failures not cached) **after** the
  admin gate, so non-admins never download `pages/admin.js`. Modules `bind()` what they need from `zqShared` into same-named
  locals so moved code stays byte-identical. `PageModulesTest` imports every entry, checks every app page is booted by
  exactly one side, and flags a shell helper a module calls without binding it (that is a ReferenceError only when the
  page opens). Page modules render into `.zq-main`, so `MobileLayoutTest` scans `assets/pages/` too.
  **Before moving a block, grep `src/test` for its distinctive lines, not just its function names — and check every test that runs a `Pattern` over the shell, since a regex's pieces don't show up in a literal grep (round 36)** — tests that read
  `zhiqu-api.js` for a call or a phrase go red (or, worse, vacuously green) once it moves. Rounds 30 and 31 each found
  some only in the full run (`latest-check.js`, `ReminderChannelWiringTest`, `RoutinePhaseTest`); scan `assets/**/*.js`.
  Test helpers for this: `SourceText.frontendScripts()` (shell + every module) and `SourceText.functionBody()` (works for the
  shell's two-space indent and modules' top level). A page that must refetch when the business day rolls over exports
  `dayReload[page]` (rounds 32, 35 — the shell's old `DAY_RELOAD` table is gone); the shell wires it to `watchBusinessDay`. Run a perturbation batch only after the clean run is
  green — round 32's first batch looked all-red partly because a new assertion was red on clean code.
- **"Today" in the frontend is `today()` — the business date (business time zone, server's clock) —
  never `toISOString()`, and since round 21 not `localDate()` either.** `toISOString()` is UTC:
  between 00:00 and 08:00 CST it yields *yesterday* (the dashboard header showed yesterday, check-ins
  broke the streak, pomodoro time landed on the previous day). `localDate()` is the *browser's*
  calendar day: a browser at UTC+14 or west of CST disagrees with the server by a day, and that date
  was being sent to the server as data. `localDate` remains only for writing a given Date in the
  viewer's own calendar. Both are exposed on `window.zqApi` so page inline scripts share the one
  implementation; see 第二十一轮 above.
- **The task form** (`openTaskForm` / `taskFormPayload`, 2026-10-01): until then 「新建任务」 asked for a title only and
  「编辑」 changed only the title — deadline, reminder time, quadrant and priority could not be set from the task page at all.
  Times are `datetime-local` values sent as-is (business-zone wall clock, never through `Date`). The server does not store
  the 「截止前提醒」 setting, only the reminders it scheduled, so the edit form shows the days of the still-PENDING `AUTO`
  reminders; `reminderOffsets: null` means "server default", `[]` means "none". `task-form-check.js` runs the published
  `taskFormPayload`.
- **Positioning lives in a few single sources** (round 26). The home page after login is `HOME_PAGE` in
  `zhiqu-api.js` (the AI assistant) and `manifest.json`'s `start_url` must match it; the sidebar is `NAV` in `zhiqu-ui.js`
  (AI first, work pages only — settings, achievements, 专注统计, theme, admin pages and logout live in the avatar menu, round 30). Shared-plan categories are one list in three
  places — migration `V40`, `SharedPlanServiceImpl.CATEGORY_NAMES`, `PLAN_CATEGORIES` in the shell — and
  `PlanCategoryListTest` checks they agree. `PositioningCopyTest` keeps student-only phrasing (考研, 学习统计, 早八…) out of
  pages, the shell, the manifest **and every text block / string literal in `src/main/java`** — the AI's system prompts
  are where the old positioning hid longest. Matching the user's own words is the exception (`AgentPlanDecision`, and a
  per-file allow-list).
- **Several backends share one database** (round 28; the user's deployment: the desktop app and the web server both connect to
  the same remote MySQL). Every instance must use the same `app.crypto.master-key`: `CryptoKeyCanary` (a bean, so it runs
  after migrations and before Tomcat serves) refuses to start when its key cannot open `crypto_canary` — or, with no canary
  yet, when it cannot open a single sampled ciphertext (it then also refuses to write the canary, so a misconfigured instance
  that starts first cannot lock out the correct ones). `crypto_canary` is in `CryptoKeyRotation.TABLES`. Once-a-day jobs claim
  their day in `scheduled_job_claim` (`ScheduledJobClaims`) — the in-process lock fallback is per-instance. The desktop
  README's `~/.zhiqu/application.yml` template now carries `app.crypto.master-key`.
- **The AI reads the user's open tasks** (round 27, user's decision 2026-10-04: "let it read, with a switch"). A `TASK_READER`
  node (`PRE_STREAM` 12) exists only when the message is about scheduling (`AgentPlanDecision.taskReadIntent`), the mode
  is not chat-only **and** `sys_user.ai_read_tasks` is not 0 (V42; NULL means on — `SysUser.aiReadsTasks()` is the only
  place that decides). The tasks go to the model as a user-role *data* block built by `AssistantTaskContext` (titles
  flattened to one line, so a title cannot forge the block's end marker). Switch off + scheduling question → no node, but
  the answer is told the user turned it off (`AssistantTaskContext.DECLINED`) so it does not invent "your tasks today".
  "Not completed" is filtered in the query only (`AssistantTaskReader`) — filtering twice made either filter deletable
  without a red.
- **Page reminders and shared login** (round 25, `docs/rounds/round-25.md`). Every signed-in page watches
  `GET /api/reminder/upcoming` (next 24h + last 15 min, regardless of whether a third-party channel delivered it — people with
  no channel configured are exactly who needs it) and, when one is due, chimes + notifies + toasts once: "already reminded" is
  written to localStorage **before** notifying so other tabs skip it. Notification permission is only requested inside a
  click (pomodoro start, saving a task with a reminder/deadline) — browsers refuse otherwise. Tabs share the login over
  `BroadcastChannel('zq-auth')`: a tab without a token borrows one before `initAuth()`; logout and password change are
  broadcast but only act on tabs holding **the same token** (another tab may be signed in as someone else).
- **One pomodoro clock for the whole site** (round 49, `docs/rounds/round-49.md`, step 1 of `docs/mini-pomodoro-plan.md`).
  The state lives in localStorage `zq.pomo.<user id>` (`{id, phase: running|paused|done, total, endAt | left, taskId, taskTitle, rev}`),
  so leaving the dashboard no longer drops a running pomodoro and every signed-in page shows 「专注中 18:42」 above the avatar.
  `watchPomo()` ticks once a second, follows `storage` events and re-reads on `visibilitychange`; every change goes through
  `changePomo(fn)` under the Web Lock `zq-pomodoro` (read → check it is still the same one → write, `rev`+1). At the end only the
  tab that flips running → done records and notifies; the record's idempotency key is the pomodoro id, so the server keeps one
  even when two tabs race without Web Locks. Other tabs only mark their title. A clock set back is detected against
  `performance.now()` and shifted once (a tab only shifts the `rev` it saw last tick). A pomodoro that ended while no page was
  open is recorded on the next page load for the day it ended, silently if more than 15 min late; closing every page no longer
  abandons it (press 重置). The dashboard card (`pages/dashboard.js` `wirePomo` / `drawPomo`) only draws and forwards clicks.
  Logout deletes the state like drafts. Checks: `pomo-shared-check.js` (two simulated tabs sharing storage and a lock),
  `pomo-card-check.js`, `PomodoroSharedTest`.
- **The mini pomodoro page** (round 50, `mini.html` + `assets/pages/mini.js`): a dark translucent capsule (play/pause with a
  progress ring, countdown, linked task · 「今天第 N 轮」, expand) for the macOS floating panel of step 3. It boots through `route()` like
  any page and draws from the shell's `pomo`. Differences from other pages: no sidebar or page head; `html.zq-mini-page` makes the page
  transparent and must out-rank the phone `@media` block's `.zq-main{margin-left:56px}` (the panel is narrower than a phone); the capsule
  colours are `--zq-mini-*` tokens with the same values in light and dark; when signed out it does not navigate to the login page —
  `redirectToLogin` adds `zq-signed-out` and the capsule says 「在主窗口登录后再用」; 「展开」 posts `{action:'expand'}` to
  `webkit.messageHandlers.zqMini` when the shell provides it, otherwise goes to the dashboard. A new HTML page also needs an entry in
  `SecurityConfig`'s permit list (missing → a blank 403), `service-worker.js` `CORE_ASSETS` and `PAGE_MODULES`.
- **The tasks page** (round 52, step 6 of `docs/ui-plan.md`): one toolbar — search (title and description, 300 ms after typing
  stops, Enter at once), a status segment, and 「筛选」 opening a second row (quadrant, priority, sort) whose button shows how many
  are set; changes reload at once (`latestOnly`, no 「查询」 button). Search runs on the server (`/task/page?keyword=`): titles and
  descriptions are encrypted, so the service decrypts up to 5000 rows matching the other filters, filters in memory, then pages
  (`searchCapped` when there were more). Deadline-ascending sorts undated tasks last (`deadline IS NULL` via a `QueryWrapper`
  whose `.lambda()` carries the rest). Column widths live only in `.zq-task-grid`; deadline and reminder share one cell so the table
  fits a 960-px desktop window without horizontal scrolling; edit/delete are icon buttons shown on hover or keyboard focus, always
  on phones, where each row stacks instead of scrolling sideways. Checks: `tasks-check.js`, `TasksLookTest`, `LargeAccountIntegrationTest`.
- **WebKit is not Chromium** (round 53). The built-in browser is Chromium; the desktop app is WKWebView. The stylesheet's
  `appearance: base-select` (customizable `<select>`) is Chromium-only — WebKit falls back to the native gradient control, so
  `@supports not (appearance: base-select)` gives `.zq-select` / `.zq-composer-model` `appearance:none` and a gradient caret.
  The week calendar is a size container (`container-type: inline-size`): narrower than 560px each day stacks weekday over date,
  narrower than 260px the paddings and circle shrink — the dashboard's calendar card is ~320px wide in a 960-px desktop window,
  where side-by-side cells pushed the date 24px out of the cell. `DesktopWebKitLayoutTest` lays out the published CSS and the real
  `renderWeek` markup in an off-screen WKWebView and measures it.
- **Markdown is classes, not inline styles** (round 55, step 7 of `docs/ui-plan.md`). `renderMarkdown` wraps its output in
  `<div class="zq-md">` and emits bare tags plus five classes (`zq-md-table`, `zq-task-row`, `zq-math`, `zq-math-i`, `zq-mono`); the
  look is `.zq-md …` in `zhiqu-ui.css`, with exactly the values the inline styles had (the AI assistant's messages measured the same
  before and after). Only the code highlighter's colour spans stay inline. Before, the Wiki editor's inserted headings and checklists had
  none of the inline styles and looked different from rendered ones. The Wiki's body adds `.zq-prose`: at most 42em per line
  (42 characters at 15px — it was 70+ at 1440 wide), line height 1.85, headings 24 / 19 / 16 / 15 with more space above than below,
  no underline under h3. A first-line h1 equal to the page title gets `.zq-dup-title` and is hidden while reading, shown while
  editing; it stays in the content, so saving keeps it. **Don't reuse Markdown's class names for page markup**: round 52 named the
  tasks-page rows `.zq-task-row`, the checklist class, and every Wiki checklist was drawn as a task-table row (padding, a rule,
  grid) for three rounds — the rows are `.zq-task-line` now. `markdown-check.js` (via `WikiLookTest`) runs the published
  `renderMarkdown` (attribute allow-list, block shapes, a CSS rule for every class and tag) and scans pages and modules for
  anyone else emitting those classes.
- **The routines page** (round 56, step 8 of `docs/ui-plan.md`, first of three rounds): two blocks only — 「今天」 (today's
  occurrences from `/routine/instances?from=today&to=today`, drawn like the dashboard's 「今天」 with `.zq-agenda-row`, done rows
  faded, check-in dated to the row's own date) and 「全部例行计划」 (active, then upcoming, then ended; delete is a hover icon button).
  「新建例行计划」 and 「从任务生成」 are page-head buttons opening dialogs that share one settings block (`settingsHtml`): daily/weekly
  segment, weekday chips shown only for weekly with today's weekday pre-pressed (the server picks today when none is sent — now the
  user sees it), time, duration, reminder; the new-routine dialog adds name, description, start/end. `readRoutineForm` turns the
  values into the POST body or a reason it can't be sent. Before, 「标记完成」 sat on every in-range routine, so on a Saturday the
  Mon/Wed/Fri ones failed with 「该日期不在例行计划范围内」, and the page never showed whether today's was done.
  `routines-check.js` (via `RoutinesLookTest`) imports the module and drives it with stand-ins for the shell (double clicks,
  a failure half-way through generating, check-in through `safe`, `dayReload`).
- **Pages carry no demo data** (2026-10-04). 12 of the 14 pages used to ship inline scripts that wrote a fabricated
  study plan into the DOM before `zhiqu-api.js` loaded, plus hardcoded numbers in the static HTML («共 1,284 个账号»,
  «第 17 教学周»). On a failed load `renderInitError` hid them; on a *successful* load whatever the boot code didn't
  repaint stayed on screen — 「已审核模板 · 4 个」, 「第 3 轮」 and a 60% progress bar all shipped that way.
  `InitErrorReplacesDemoContentTest` now pins: only the one-line theme script may be inline (the dashboard's pomodoro script
  was the other exception until round 49 moved the clock into the shell); any digit in a page's static `.zq-main` text must be on its short list of real copy; and a failed load still
  replaces all of `.zq-main`. The real controls the demo scripts used to draw (statistics 日/周/月, achievement filters,
  routine weekdays, the shared-plan modal's close buttons) now live in the static HTML and are bound by the shell — the
  same test pins that, because deleting them breaks the page silently. `index.html` (landing page mockups) is excluded
  until the positioning step rewrites it.
- **Cache busting**: every page loads assets with a shared `?v=<token>` and `service-worker.js`
  keys its cache off the same token (`ZHIQU_CACHE = 'zhiqu-shell-v<token>'`). After changing any
  asset, bump the token in **all** HTML files *and* the service worker, otherwise users keep the
  old bundle. Current token: see `CLAUDE.md` (前端的规矩).
  `StaticAssetCacheTokenTest` enforces that every `?v=` and `ZHIQU_CACHE` agree — the token is
  a **browser** HTTP-cache buster (the service worker is network-first and matches with
  `ignoreSearch`), so a drifted page silently keeps serving the old bundle.
