# AI 助手与拆 AiServiceImpl

> 原来是 `CLAUDE.md` 里的「AI assistant」「拆 AiServiceImpl（进行中）」，第三十八轮（方案第 5 步，`CLAUDE.md` 瘦身）原样挪到这里，一字未改。
> `CLAUDE.md` 现在只留规矩；这里是来龙去脉和细节。文中「上面」「下面」指的是原来 `CLAUDE.md` 里的位置。

### AI assistant

- Chat streams over SSE (`POST /api/ai/chat/stream`). **`SecurityContext` does not propagate to the
  async thread**, so tool executors take an explicit `userId`.
- Planning uses OpenAI-style function calling (`create_study_plan`). With **both** a plan word (计划/规划/安排/任务…)
  **and** a create word (生成/创建/制定/添加…) — `AgentPlanDecision.taskCreationIntent()` — the tool call is forced.
  With only a plan word ("帮我把下周的工作安排一下", `planMention`), a tool-calling model outside chat-only mode gets the tool
  with `tool_choice: auto` plus `PLAN_DECIDE_PROMPT`, and **not calling it means no** — there is deliberately no keyword
  fallback extraction on that path (user's decision 2026-10-03, round 25). The lifecycle test's fake model calls the tool only
  when the request quotes the user's sentence verbatim; the decide prompt contains that very sentence as an example.
- **One plan, one confirmation** (2026-10-03): PLANNER turns the plan into one `PLAN_DRAFT` (tasks + routines); TASK_DRAFTER
  only builds `TASK_DRAFT` / `ROUTINE_DRAFT` when PLANNER did not (project milestones). Both used to build drafts from the same
  plan — three dialogs, and confirming the first then the second wrote every task twice. The lifecycle integration test's fake
  model now answers `create_study_plan` with a real tool call; before that, no test ever reached the plan-draft path.
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

**第五刀**是 code agent 的工具循环 → `service/ai/CodeWorkspaceAgent`（大类 4992 → 4486 行）。
照第四刀的规矩**先量再搬**：这一块用到 8 个大类字段，全是注入的服务，**0 个 `StreamState` 字段**
（检索 runner 是 22 个）—— 所以能整块搬，形状就是第二刀的 `WikiToolAgent`。搬完之后大类不再依赖
`WorkspaceService` / `WorkspaceExecutor` / `AdminGuard`，「工作区能不能读」只剩 `readableBy` 一处。

和 PLANNER 的接缝是 `CodeWorkspaceAgent.MilestonePlanning`：里程碑必须用 PLANNER **同一份**
`create_study_plan` schema 和解析器，所以它们留在原处，只通过这个窄接口借出去。
`MilestonePlanning.of(schema, parser, usable)` 顺带改掉一个行为：PLANNER 的解析器对坏 JSON 抛异常，
搬家前它会冲出工具循环、让整轮提前结束；现在变成回模型一句「参数不对」，循环继续。
Wiki 的工具名也收成了一份（`WikiToolAgent.TOOL_NAMES`）—— code agent 原来手写了一份，
旁边注释「与 buildWikiTools 保持一致」，靠注释维持的一致就是第二份真相。

**搬家时判据怎么跟着走**（这次照「扫错文件的判据看起来和通过一模一样」逐条处理的）：每条判据读
**它那条性质现在住的文件**；`assertFalse` 类的**两个文件都查**（只查旧文件的话，代码一搬走它自动变绿）；
计数类要求新文件 `== 1`、旧文件 `== 0`。扰动 S9 往**新**文件里塞了一个另起的意图判定，
改过指向的 `assertFalse` 红了 —— 这一步证明它真的在看新文件。

换到的东西和第四刀一样：这个循环**第一次能真跑着测**。以前它的几道门只有扫源码的判据（钉写法、
钉不住行为），现在 `CodeWorkspaceAgentTest` 拿脚本化的假模型喂越权调用、没读过就改、坏的里程碑参数。
其中一条被扰动照出是弱的：拿掉「没下发就拒绝」之后「不产草稿」那半条照样绿 ——
假工作区对那个文件返回 null，被「没读过不许改」**另一道门**顶替了。改成真正的新文件（`ABSENT`）之后
两半断言各自能红。**一个断言绿着，可能是因为别的防护替它挡了。**

**第六刀**是 `create_study_plan` 这个工具 → `service/ai/StudyPlanTool`（schema、解析器、`hasContent`；
大类 4486 → 4256 行，不再依赖 `ReminderPlanService`）。同样先量：8 个方法只用到时钟、提醒服务、
ObjectMapper，0 个轮次状态字段。第五刀那个 `MilestonePlanning` 接缝只因为解析器住在大类里才需要；
它有了自己的家，code agent 直接依赖它，接缝和大类里的适配器一起删了 —— **接缝是为了当时的约束而存在的，
约束没了它就该走**。

这一刀多做了一步：**先拍金样再搬家**。搬之前用反射调大类里原来的私有方法（时钟固定、提醒服务打桩），
把 schema 和一组边界输入的解析结果写进 `src/test/resources/golden/study-plan-tool.json`；
`StudyPlanToolTest` 拿新类的输出按 JSON 树逐项比。于是「搬家不改行为」是验证过的，不是口头保证的 ——
扰动时它连「提醒偏移排序反了」「默认结束日期差一天」都抓到了。

新判据第一次跑就报了一个「第二份 schema 声明」在 `AiServiceImpl` 里 —— 查下来是**误报**
（命中了 tool_choice 的 `Map.of("name", "create_study_plan")`），但它照出了真问题：工具名的字面量散在
四个文件共 7 处。改了声明漏了别处，tool_choice 强制一个不存在的工具、按名字匹配的地方永远匹配不上，
计划静默地产不出来。现在是 `StudyPlanTool.NAME` 一份，判据改成最朴素的「去掉注释后字面量全仓只出现一次」。
**误报也要查到底**：这一次误报的原因本身就是个真 bug。

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
