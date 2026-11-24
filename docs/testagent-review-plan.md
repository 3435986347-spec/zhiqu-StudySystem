# testagent（zhiqu）vs 对照组（dsh）：差异、不足与落库方案

> 同一个目标：「做一个对话和工具 agent，网页版，要求对话能看到每一步的工具调用和思考过程」
> - testagent：`testagent/`（本机目录，不在本仓库）（zhiqu 产出，会话日志 `.zhiqu/sessions/20261124-181317-d56e.jsonl`（私人数据，不进仓库，这里只引用统计））
> - 对照组：`对照组/agent-web/`（本机目录，不在本仓库）（dsh 产出）

---

## 1. 两个项目的差异总览

| 维度 | testagent（zhiqu） | 对照组（dsh） |
| --- | --- | --- |
| 代码量（不含数据） | 约 3.5k 行（server 239 / lib 1027 / 前端 2735） | 约 5.6k 行（server 510 / lib 1627 / 前端 3315 / 测试 1291） |
| 会话存储 | **只存在浏览器 localStorage**，整份会话数组在每轮结束时全量重写；超出配额时静默丢弃（`app.js:217-227`） | 存在服务端 `data/sessions/{id}.json`，先写 tmp 再 rename，原子写；**用户消息先落盘**，取消或出错时保留已执行的步骤 |
| 上下文（history）由谁决定 | **由前端决定**：前端拼好 `messages`（含 tool 结果）发给后端，后端全盘采信（`server.js:91`、`agent.js:34`） | 由服务端决定：前端只发 `sessionId + message`，后端从落盘数据还原（`toLLMMessages`） |
| 模型配置 / API Key | 存在 localStorage，每次请求都放在 body 里明文传 | 存在服务端 `data/config.json`（权限 600），前端只拿到掩码 |
| 工具 | list_dir / read_file / write_file / **run_shell（任意 bash）** / fetch_url | 时间 / 计算器（自写解析器，不用 eval）/ 文件读写 / fetch_url |
| 沙箱 | 有路径沙箱，但 **`cwd` 由请求体指定**，等于没有边界 | 固定在 `data/workspace`，防 `../` 和软链接逃逸 |
| 跨域 / SSRF | `Access-Control-Allow-Origin: *`；fetch_url 没拦内网地址 | 严格 CSP；fetch_url 拦截本机和内网地址 |
| 并行工具调用 | 不支持，串行执行 | `Promise.all` 并行执行 |
| 思考过程展示 | 流式思考、**参数也流式展开**（这一点比对照组好） | 流式思考，带耗时和字数；参数解析完一次性展示 |
| 原始事件审计 | 没有 | 有「原始事件」抽屉（只存在内存里） |
| 中断 / 停止 | 前端断开连接触发 abort；取消的那一轮**不保存 history** | 有 `/api/chat/stop`，同一会话并发返回 409，取消时保留部分步骤 |
| Token 用量 | `done` 事件里只有最后一轮的 usage | 每步 usage 累加 |
| 测试 | 只有一个 `tests/fake-openai.js` 假服务；**验证脚本跑完就删了**，仓库里没有可以重跑的测试 | 15 个 node:test 单测和端到端测试，加 CDP UI 自动化断言和截图 |
| 启动后可用性 | 零依赖，直接能跑 | 零依赖，直接能跑 |

**结论**：两边都满足字面要求（能看到思考和工具调用），testagent 在「参数流式展开」上体验更细。但在**数据归属（落库）、信任边界、安全、可回归性**这四块明显落后。

---

## 2. testagent（产物）的不足，按严重程度排序

### P0：安全问题（已实测确认）
1. **任意网页都能在本机执行任意命令。** `server.js` 对所有路由都返回 `Access-Control-Allow-Origin: *`，OPTIONS 直接回 204；`POST /api/tool` 是调试接口，没删掉，而且 `cwd` 由请求体决定。实测从伪造的 `Origin: https://evil.example` 发 `run_shell`：
   ```
   {"ok":true,"output":"$ echo cross-origin-ok && pwd\ncross-origin-ok\n/private/tmp\n— 退出码 0"}
   ```
   也就是说，服务运行期间，用户浏览器打开的任意网页都可以 `fetch('http://127.0.0.1:7317/api/tool', …)` 在本机执行 shell。`/api/chat` 同样能指定 `cwd` 和 `baseURL`（攻击者可以指向自己的假模型）。
2. **沙箱形同虚设**：`config.cwd` 来自客户端（`server.js:98`），设成 `/` 就能读写整个文件系统。
3. **fetch_url 没有 SSRF 防护**：可以访问 `127.0.0.1`、`169.254.169.254`、内网地址。
4. **API Key 存在 localStorage，每次请求都明文放在 body 里。**

### P1：没有落库，数据不可靠
5. 会话只存在 localStorage：换浏览器、清缓存、无痕模式下都会丢；**只在一轮结束时（`finishTurn`）才写**，生成过程中刷新页面，这一轮全部丢失。
6. localStorage 大约 5MB 配额，而 `read_file` 最多返回 200KB、`run_shell` 输出最多 12000 字符，几轮就会写满；写满后 `catch {}` 静默吞掉，**用户不知道数据没保存**。
7. **history 由客户端伪造也会被采信**：后端直接使用前端传来的 `assistant/tool` 消息，可以伪造工具结果来注入上下文，也无法做服务端审计。
8. 取消（`cancelled`）的那一轮没有 `history`，下一轮上下文中这一轮的工具链就断了；取消后已经真实执行过的 `write_file` 和 `run_shell` 副作用也没有留下任何记录。
9. 没有原始事件记录，「看到每一步」只在当下的页面里成立，无法事后回放或审计。

### P2：功能与工程
10. 不支持并行 tool_calls（README 自己承认）。
11. 没有可以重跑的测试：zhiqu 写过 `.tmp-multiturn.js`（多轮回归）和 `.seed-demo.js`，验证完都删进了 trash。
12. 滚动跟随最后是用**定时器兜底**（`startFollow/stopFollow`）规避的，根因没有查清（见 3.2）。
13. 为了让截图能等到收尾，**调快了 mock 的播放节奏**（10:30:41），相当于为了迁就验证工具去改产品行为。
14. usage 只统计最后一轮，没有累加。

---

## 3. zhiqu（agent 本身）在这次会话中的不足

以下依据会话日志（10:13 → 10:49，共 36 分钟，255 条消息，99 次模型调用，prompt 约 968 万 token，其中 97% 命中缓存，completion 约 12.5 万）。

### 3.1 需求阶段：验收标准漏了「数据归属」和「安全」
- 开工前只问了两个问题：「接哪个模型」「工具范围」。用户选了「再加联网抓网页」，但 zhiqu 自己加了 `run_shell`，又没有问部署形态和暴露面。
- 写进 `goal_update criteria` 的 6 条验收标准**都是展示层的**（流式、时间线、mock 可演示……），没有「会话持久化」「信任边界」「可回归测试」。核对员是照 criteria 核对的，所以最后 `achieved` 了。**标准漏项会一路被放行。**
- 对照组把会话持久化、Key 掩码、沙箱、SSRF、CSP 都当成默认要求来做，说明对这一类产品（本地 web agent）有安全和数据方面的先验清单，zhiqu 没有。

### 3.2 执行阶段：调试路径偏长，用规避代替查根因
- **滚动跟随这个问题耗了约 12 分钟**（10:21 → 10:33），截图 10 张，先后试了 `scroll-behavior`、ResizeObserver、程序滚动时间戳、调试探针，最后的结论是「跟随回调没跑起来」，用 `setInterval` 兜底，**没有说清为什么回调没生效**。工具层的反思提醒（「这段已经改了 6 回，停一下……」）在 10:32 才触发，这时已经换方向去做种子数据了。
- **截图停在流式过程中**，问题出在验证手段（静态渲染一次性截屏）上，zhiqu 却去改了产品（调快 mock 节奏），之后又改成用种子数据静态渲染。正确的做法是换一种能等待 `done` 事件的验证方式（例如 CDP 等待某个 DOM 条件出现），对照组的 `ui-shot.mjs` 就是这么做的。
- 低级失误：`write_file` 整体覆盖了 `providers.js`，把刚写好的 OpenAI 流式解析冲掉了（10:16），读了文件才发现，又补了回来；`apply_patch` 失败 3 次（空补丁、空白不匹配、多处匹配）；一次批量 `delete_file` 违反「删除前先读」的规则，全部被拒后重来。

### 3.3 验证阶段：证据偏弱，而且没留下来
- todo 中 5 个后端条目的 evidence 都是「`node --check` 通过」，**语法检查被当成了功能证据**。
- 真正的功能回归（多轮 4 个剧本、mock 和 fake OpenAI 双链路）都写成了临时脚本，**用完就删了**，用户拿不到可以重跑的测试。对照组把同样的验证固化成了 `npm test`。
- 安全验证只测了「`../` 越界会被拒绝」，没有从**调用方是谁**这个角度检查信任边界（跨域、cwd 由客户端指定、调试接口留在生产代码中）。

### 3.4 收尾：已知缺陷写进了 README，但没有提醒用户
README 末尾写了「会话只在浏览器本地……没有服务端持久化」「run_shell 不做隔离」，但最终回复里没有把这些当作需要用户决策的风险提出来。

### 3.5 对 zhiqu 的改进建议（agent 层面）
1. **按产品类型准备默认验收清单**：识别到「web 版 agent / 带工具的服务」时，自动往 criteria 里加入：持久化、信任边界（谁能调用、参数由谁决定）、密钥存储、可重跑测试。
2. **临时验证脚本默认保留**：把 `.tmp-*.js` 转成 `tests/*.test.js` 留在仓库里，只删一次性的预览页。
3. **evidence 分级**：`node --check` 只算 L0 证据，「done」至少要求 L2（真实请求和断言）。
4. **同一处改到第 3 次就强制要求写出根因假设**，不要等到第 6 次才提醒；并且禁止为了迁就验证手段去改产品参数。
5. **收尾时把 README 里的「已知边界」升级成风险，向用户提问**（例如「run_shell 加 CORS * 会导致……要不要收紧？」）。

---

## 4. 落库方案（testagent）

### 4.1 目标
1. 服务端成为会话的**唯一事实来源**：刷新、重启、换浏览器都能完整恢复，思考、说明、工具参数、工具结果、耗时、状态一样都不少。
2. **生成过程中边执行边落盘**：页面崩溃或刷新后，能看到已经发生的步骤，正在运行的轮次可以重新订阅。
3. **原始事件可以回放和审计**（对照组只存在内存里，这里补上）。
4. 保持零 npm 依赖。

### 4.2 选型：`node:sqlite`（内置）+ 大结果外置文件
- 本机 Node v26.8.2 已经验证 `require('node:sqlite').DatabaseSync` 可用（SQLite 3.53.4），不需要 npm install。
- 为什么不像对照组那样每个会话一个 JSON 文件：每写一次都要全量重写，没法做到流式过程中逐事件落盘；`listSessions` 要读出所有文件；并发和崩溃时只有 rename 这一层保护。SQLite 的 WAL 模式加事务能直接解决这些问题，而且支持按会话、工具名、失败状态查询。
- `package.json` 的 `engines` 要从 `>=18` 改成 `>=22.13`（`node:sqlite` 不再需要 flag 的最低版本）。也可以保留一个 JSON 文件后端作为降级（见 4.8）。

数据目录：`data/`（加入 `.gitignore`）
```
data/
├── agent.db            # SQLite，WAL 模式
├── blobs/ab/abcdef…    # 超过 64KB 的工具输出，按 sha256 分片存放
└── config.json         # 模型配置和 API Key（权限 0600）
```

### 4.3 数据模型

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,            -- uuid
  title        TEXT NOT NULL,
  cwd          TEXT NOT NULL,               -- 服务端决定，创建后不可改
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER                      -- 软删除
);

CREATE TABLE turns (                         -- 一轮 = 一条用户消息 + agent 的完整执行
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,             -- 会话内序号
  user_text    TEXT NOT NULL,
  status       TEXT NOT NULL,                -- running|done|error|cancelled|interrupted
  mode         TEXT, model TEXT,             -- mock/openai，模型名快照
  final_text   TEXT,
  error        TEXT,
  rounds       INTEGER DEFAULT 0,
  tool_calls   INTEGER DEFAULT 0,
  usage_json   TEXT,                         -- 累加后的 usage
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  UNIQUE(session_id, seq)
);

CREATE TABLE steps (                         -- 一轮中的一次 LLM 调用（round）
  turn_id      TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  idx          INTEGER NOT NULL,
  thinking     TEXT DEFAULT '',              -- reasoning 全文（展示用，不回传给模型）
  text         TEXT DEFAULT '',              -- 中间说明或最终回答
  finish_reason TEXT,
  usage_json   TEXT,
  started_at   INTEGER NOT NULL,
  elapsed_ms   INTEGER,
  PRIMARY KEY (turn_id, idx)
);

CREATE TABLE tool_calls (
  id           TEXT PRIMARY KEY,             -- `${turn_id}:${call_id}`
  turn_id      TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  step_idx     INTEGER NOT NULL,
  call_id      TEXT NOT NULL,                -- 模型给出的 tool_call_id
  ord          INTEGER NOT NULL,             -- 同一步内的顺序
  name         TEXT NOT NULL,
  raw_args     TEXT,                         -- 原始参数字符串（包括解析失败的）
  args_json    TEXT,
  status       TEXT NOT NULL,                -- pending|running|ok|error|cancelled
  output       TEXT,                         -- ≤64KB 直接存这里
  output_blob  TEXT,                         -- 超过 64KB 时存 sha256，output 只存头部预览
  output_bytes INTEGER,
  meta_json    TEXT,                         -- 退出码、截断标记等
  started_at   INTEGER, elapsed_ms INTEGER
);
CREATE INDEX idx_tool_calls_turn ON tool_calls(turn_id, step_idx, ord);

CREATE TABLE events (                        -- 原始 SSE 事件，只追加，用于回放、断线续传和审计
  turn_id      TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  ts           INTEGER NOT NULL,
  type         TEXT NOT NULL,
  payload      TEXT NOT NULL,                -- JSON
  PRIMARY KEY (turn_id, seq)
);

CREATE TABLE schema_version (v INTEGER NOT NULL);
```

说明：
- **不单独存 OpenAI messages 表**：LLM 上下文由 `turns + steps + tool_calls` 推导出来（同对照组的 `toLLMMessages`），避免两份数据不一致。推导规则：`thinking` 不回传给模型；`status=cancelled/interrupted` 的工具调用，补一条 `tool` 消息，内容为「已中断，未拿到结果」，保证 tool_call_id 能配对，不让上下文断链。
- 卡片（UI 时间线）同样由这三张表推导出来，前端不再保存 `cards`。

### 4.4 写入时机（边执行边落盘）
在 `runAgent` 外层包一个 `Recorder`，`emit` 先经过 Recorder 再推给 SSE：

| 事件 | 落盘动作 |
| --- | --- |
| 收到 `/api/chat` | 事务：插入 `turns(status=running)`，更新 `sessions.updated_at`；**插入成功后再建立 SSE** |
| `round_start` | 插入 `steps(idx)` |
| `thinking_delta` / `text_delta` | 写入内存缓冲；**每 250ms 或每 2KB** 批量 UPDATE `steps.thinking/text`，并把合并后的 delta 写入 `events` |
| `tool_call_start` / `args` | `events` 追加；`tool_call_ready` 时插入 `tool_calls(status=running, args)` |
| `tool_result` | UPDATE `tool_calls`（status、output 或 blob、elapsed_ms）；`turns.tool_calls+1` |
| `round_end` | 刷新缓冲，UPDATE `steps.elapsed_ms/finish_reason/usage` |
| `done` / `error` / `cancelled` | 刷新缓冲；UPDATE `turns`（status、final_text、usage 累加、ended_at） |
| 服务启动 | `UPDATE turns SET status='interrupted' WHERE status='running'`，同时把对应 `tool_calls.status='running'` 改为 `cancelled` |

- 所有写入都走同一个 `DatabaseSync` 连接，用同步事务（Node 单线程，不存在并发写冲突）；delta 合并后写入，避免每个字一次 IO。
- 工具调用的**副作用**（写文件、跑命令）即使被取消也会在 `tool_calls` 中留下记录，满足审计需求。

### 4.5 API 变更

| 方法 | 路径 | 变化 |
| --- | --- | --- |
| POST | `/api/chat` | 请求体改为 `{ sessionId?, message }`，**不再接收 `messages`、`cwd`、`apiKey`**；第一个事件是 `session {sessionId, turnId}`；每个 SSE 事件带上 `seq`，并设置 `id: seq` |
| POST | `/api/chat/stop` | `{ turnId }`，服务端 abort（不再依赖客户端断开连接） |
| GET | `/api/turns/:id/stream?after=seq` | **断线续传**：先从 `events` 补发 `seq>after` 的事件，如果这一轮还在运行，就继续订阅实时事件（内存中维护 `turnId → Set<res>`） |
| GET | `/api/sessions` | 列表（id、标题、轮数、工具次数、更新时间） |
| GET | `/api/sessions/:id` | 返回 turns，以及每轮的 steps 和 tool_calls（工具输出默认只给预览） |
| GET | `/api/tool-calls/:id/output` | 按需获取完整输出（包括存在 blob 中的） |
| GET | `/api/turns/:id/events` | 原始事件（审计抽屉用） |
| DELETE | `/api/sessions/:id` | 软删除；后台任务定期清理并回收 blob |
| GET/POST | `/api/config` | 服务端保存配置，Key 只返回掩码 |
| POST | `/api/import` | 一次性导入旧 localStorage 数据（见 4.7） |
| ~~POST~~ | ~~`/api/tool`~~ | **删除**（或只在 `NODE_ENV=development` 且校验 token 时开放） |

### 4.6 前端改造
- `loadStored/saveSessions` 改为调用 `/api/sessions*`；`state.sessions` 只缓存列表，进入会话时再拉取详情。
- 渲染：新增 `turnToCards(turn)`，把 steps 和 tool_calls 映射成现有的 `thinking/note/tool/final/error` 卡片，**直接复用现有渲染函数**。
- 刷新时如果发现 `status=running` 的轮次，自动调用 `/api/turns/:id/stream?after=<本地最后 seq>` 续上。
- localStorage 只保留 `currentId` 和 UI 偏好，不再存会话内容和 Key。

### 4.7 迁移旧数据
第一次加载时，如果检测到 `quadrant-agent:sessions:v1`：
1. 调用 `POST /api/import`，提交 `{ sessions }`。服务端把每个 turn 的 `cards` 和 `assistant.messages` 转换后写入；无法还原的字段写进 `events(type='imported_legacy')`，保留原始数据。
2. 导入成功后把 localStorage 中的数据改名为 `…:v1:migrated`（保留 7 天再删除，可以回滚）。
3. 旧数据中的 apiKey：提示用户是否转存到服务端，不自动上传。

### 4.8 实施分期

| 阶段 | 内容 | 验收（要写成 `npm test` 可以重跑） |
| --- | --- | --- |
| **0. 先止血（安全）** | 删除 `/api/tool`；去掉 CORS `*`，校验 `Origin/Host` 只能是本机；`cwd` 改成服务端配置并禁止由请求覆盖；fetch_url 拦截环回、链路本地和私有网段；Key 移到服务端 | 跨域 POST 返回 403；请求体带 `cwd:"/"` 无效；fetch `http://127.0.0.1` 被拒绝 |
| **1. 存储层** | `lib/store.js`：建表和迁移、Recorder、blob 外置、启动时把运行中的轮次标记为 interrupted | 单测：一轮 mock 跑完后数据库中 steps 和 tool_calls 与 SSE 事件一致；kill -9 后重启，状态为 interrupted，已执行的工具调用都有记录 |
| **2. 接口与上下文** | `/api/chat` 改成以服务端为事实来源；`toLLMMessages`；stop 和续传接口 | e2e：两轮对话，第二轮的上下文中含第一轮的 tool 结果；伪造的 history 被忽略；取消后下一轮的 tool_call_id 都能配对 |
| **3. 前端** | 改成 API 存取、`turnToCards`、断线续传、审计抽屉、迁移 | UI 自动化：生成到一半刷新，能续上并看到完整时间线；重启服务后会话还在；换浏览器能看到同样的会话 |
| **4. 运维** | 软删除清理、blob 垃圾回收、`data/` 体积上限告警、导出单个会话为 JSON | 删除会话后 blob 被回收；导出的 JSON 能重新导入 |

可选：`STORE=json` 环境变量切换到「每个会话一个 JSON 文件」的后端（同对照组的实现），用于 Node < 22 的环境。Recorder 接口不变，只换存储实现。

### 4.9 风险与取舍
- `node:sqlite` 要求 Node ≥ 22.13，低于这个版本时用 JSON 后端兜底。
- `events` 表会膨胀：delta 合并后再写入，每轮通常只有几十到几百行；超过 30 天的轮次可以只保留关键事件（tool_* / round_* / done）。
- 工具输出可能包含敏感内容（例如 `run_shell` 读到的环境变量）：数据库文件权限设为 0600，并提供「删除会话 = 删除数据库记录和 blob」的硬删除选项。

---

## 5. 附：对照组同样存在、落库方案顺带补上的点
- 原始事件只存在内存里，刷新就丢 → 本方案用 `events` 表持久化。
- 一轮运行中进程崩溃，这一轮的步骤全部丢失（只在结束、取消或出错时写入） → 本方案边执行边落盘，重启时标记为 interrupted。
- 每次保存都全量重写 JSON，列表接口要读出所有会话文件 → 本方案用 SQLite 增量写入加索引查询。
