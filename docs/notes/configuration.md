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
