# 配置

> 原来是 `CLAUDE.md` 里的「Configuration」，第三十八轮（方案第 5 步，`CLAUDE.md` 瘦身）原样挪到这里，一字未改。
> `CLAUDE.md` 现在只留规矩；这里是来龙去脉和细节。文中「上面」「下面」指的是原来 `CLAUDE.md` 里的位置。

## Configuration

`zhiqu-backend/src/main/resources/application.yml` (production template:
`deploy/windows/application-prod.example.yml`):

- Database — `spring.datasource.*` (default DB `zhiqu_db`)
- Redis — `spring.data.redis.*` (rate limiting, locks)
- JWT — `jwt.secret`, `jwt.expiration`
- Uploads — `app.upload-dir`
- Desktop installers — `app.desktop-downloads-dir` (default `downloads`, relative to the working directory; round 82). The web "下载桌面版" dialog offers the newest `.dmg` (macOS) and `.exe/.msi/.zip` (Windows) found there; not in git, not in the JAR. `package-macos-native.sh` copies the dmg in when `ZHIQU_DOWNLOADS_DIR` is set.
- Sampling temperature — `app.ai.temperature` (default empty = not sent; newer Claude models reject the parameter) and
  `app.ai.harness-temperature` (default `0`, round 89): the command-line coding loop (`/api/harness/model/stream`) sends its own
  temperature. Left unset, DeepSeek samples at its default 1.0 and the same task took different paths run to run (three of ten
  SWE-bench tasks flipped across three reruns); DeepSeek's docs recommend 0 for code. A provider 400 that mentions `temperature`
  makes `HarnessModelGateway` drop it and retry once (before any output). Empty = fall back to `app.ai.temperature`.
- Thinking tier — `app.ai.harness-reasoning` (default `off`, round 108): which tier the command line gets when it does not say
  (`instant` / `medium` / `high` / `extra` / `max`; `off` means `instant`). The default stays off until a real-model comparison says
  otherwise: rounds 12 and 54 turned thinking off for real reasons (slow, spinning). The web code mode always says its own tier, so
  this key does not reach it. Benchmarks use this key rather than a request field, so the broker's exact-body check stays as it is.
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

## 代码功能（生成到产物，第一百一十六轮）

| 配置 | 默认 | 说明 |
|---|---|---|
| `app.workspace.artifact-dir` | `~/.zhiqu/artifact-spaces` | 每段对话的临时空间放哪。可以随时清，接着聊时从数据库恢复 |
| `app.workspace.artifact-retention-days` | `3` | 临时空间几天没动就清 |
| `app.workspace.hosted-enabled` | `false` | 服务器上（生产 profile）的代码功能。打开了也不碰服务器的磁盘，只生成到产物 |
| `app.workspace.hosted-shell-enabled` | `false` | 服务器上跑命令（第一百一十七轮）。要 `hosted-enabled` 也开着，bubblewrap 起不来也不跑 |
| `app.workspace.hosted-shell-timeout-ms` | `60000` | 服务器上一条命令最多跑多久，模型要得再长也是这么长 |
| `app.workspace.hosted-shell-slots` | `2` | 服务器上同时跑几条（全站）；一个账号一次一条 |
