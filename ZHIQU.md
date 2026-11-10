# ZHIQU.md

给以后在这个仓库里干活的 coding agent 看的工作说明。

**先读这一段。** 同一目录里，`zhiqu` 命令行只加载 `ZHIQU.md`，不再读 `CLAUDE.md`（`zhiqu-cli/src/instructions.js`）；但 `CLAUDE.md` 才是完整、权威的规矩，这份文件只是入口和主线，冲突时以 `CLAUDE.md` 与代码为准。`CLAUDE.md` 两万多字符，超过命令行 20K 的单文件上限，整份读进来时只有前面一段 —— 所以这里不搬运它，只留下做事前必须知道的。细节按主题在 `docs/notes/`，每一轮的经过在 `docs/rounds/round-NN.md`。`README.md`、`AGENTS.md` 里有陈旧数字（迁移版本、旧前端目录），别拿它们判断现状。下面提到的迁移号、缓存令牌这类具体值会随每一轮变化，以代码为准。

## 这是什么

- 知趣·象限：以四象限（艾森豪威尔）为骨架的个人 AI 办公助手，带个人知识 Wiki 和可选的 RAG 语义检索。2026-10-04 之前是给大学生的学习系统；内部名字 `StudyTask`、`study_record`、`create_study_plan` 故意没改。
- 一个 Spring Boot 单体，三个入口：网页（前端打进同一个 JAR）、macOS 桌面外壳、npm 命令行 `zhiqu`（循环和工具跑在用户电脑上，服务端只做登录、模型网关、存档和远程工具）。
- 前端是原生 HTML / CSS / ES 模块，**没有构建步骤**，改完刷新即可。

## 目录：哪些是活的

- 唯一在跑的网页在 `zhiqu-backend/src/main/resources/static/`。`assets/zhiqu-api.js` 是共用层，`assets/pages/` 每页一个 ES 模块，`service-worker.js` 管 PWA 缓存。
- 根目录的 `zhiqu-ui/` 是 2026-09-02 的旧副本，**没有任何构建或服务读它**。改它不生效。
- `zhiqu-backend/target/classes/zhiqu-cli/` 是打包时塞进 JAR 的命令行源码副本。改 `zhiqu-cli/`，重新打包才会更新。
- `.claude/worktrees/` 是整份旧检出；`.zhiqu/` 是命令行的本地状态（设置、会话存档），不进 git，别改别删；`target/`、`downloads/`、`private-uploads/`、`rag-service/.venv/` 是产物或私有数据。搜索时排掉，否则会搜到旧副本。
- `conformance/` 不是文档：`text-edit.json` 和 `workspace-rules.json` 是 Java 与 JS 两份实现共用的用例表，改规矩要两边一起过。
- `rag-service/` 是可选的 Python 旁路；`tools/benchmarks/` 是评测工具（真跑要花模型钱）；`pdf-parser-eval/` 是独立 Maven 项目，不属于主构建。

## 构建、运行、部署

- JDK 17。这台机器默认 JDK 太新，Lombok 会编不过：`export JAVA_HOME=/Users/hmz/Library/Java/JavaVirtualMachines/temurin-17.0.20.1/Contents/Home`。先看 `mvn -version` 的 Java version，再怀疑代码。
- 库只要存在，结构由 Flyway 启动时迁移：`CREATE DATABASE zhiqu_db DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_general_ci;`。**不要手动执行 `zhiqu-backend/src/main/resources/db/schema.sql` / `data.sql`**（旧流程，跑出来的不是当前结构）。
- 加迁移：`zhiqu-backend/src/main/resources/db/migration/V<n>__描述.sql`。现在到 `V48`，下一个空号是 `V49`；只做加法（新表、新的可空列），老数据照样合法。
- 打包运行：`cd zhiqu-backend && mvn clean package -DskipTests && java -jar target/zhiqu-backend-0.0.1-SNAPSHOT.jar`，打开 `http://localhost:8080`。
- 本机常用 `--server.port=18080`、`--app.rag.enabled=false`。起验证用的后端时再带 `--app.workspace.state-file=$TMPDIR/zhiqu-verify-state.json`，否则它会读用户真实的 `~/.zhiqu/workspace-state.json`，还可能照用户选的档位跑命令。RAG 旁路默认开，连不上会自己退回关键词检索，不起 sidecar 也能用；健康检查是 `/health/live`、`/health/ready`，都要 bearer token，启动见 `rag-service/README.md`。
- **停实例按端口，不按进程名**：`kill $(lsof -nP -iTCP:8080 -sTCP:LISTEN -t)`。`pkill -f java` 会把 IDE 一起带走。
- `app.cookie.secure` 默认 `true`；本地 http 登录不进时临时改 `false`，上 HTTPS 后改回。
- macOS 桌面应用从第一百二十五轮起是「原生窗口打开线上网站」，包里不带 Java / JRE；**Swift 外壳改了要重新打包才到用户手里**（`bash deploy/desktop/package-macos-native.sh`），网页改了不用。Windows 版仍是 jpackage 带后端，只能在 Windows 上打。
- 线上：`ZHIQU_SSH="-i $HOME/.ssh/zhiqu_server" bash deploy/ubuntu/deploy-from-dev.sh`，细节在 `deploy/ubuntu/README.md`。Caddy 的 `@sse` 要列出每个流式接口（`deploy/ubuntu/Caddyfile`），新加 SSE 接口不加会被缓冲；改了服务器端沙箱（`zhiqu-cli/src/tools/sandbox.js` 的 hosted 那份）要在真服务器跑 `deploy/ubuntu/verify-hosted-shell.sh` —— 容器里看不到 AppArmor。

## 测试

```bash
cd zhiqu-backend
mvn -o test                            # 全量；第一次联网跑要先取 junit-platform-launcher
mvn -o test -Dtest=WikiToolGuardTest   # 单个类；多个用逗号，不是 +
mvn -o clean test                      # 改了任何 public 构造器 / 方法签名之后必须 clean
cd ../zhiqu-cli && npm test            # 命令行，node --test test/*.test.js（45 个文件）
```

- 集成测试要 Docker（Testcontainers）。**没有 Docker 时会静默跳过**：`Tests run: N, Skipped: N` 不是通过。显式跳过写 `-Dzhiqu.skipDockerTests=true`。
- 前端行为判据是 node 脚本（`zhiqu-backend/src/test/resources/js/`，68 个），由 Java 侧 `NodeRunner` 调用，直接加载发布的 `zhiqu-api.js`，不在 Java 里重写。没 node 会显式失败；用 `-Dzhiqu.nodePath=<绝对路径>` 指位置，`-Dzhiqu.skipNodeTests=true` 才是显式跳过。
- 测试配置在 `zhiqu-backend/src/test/resources/application.properties`：Redis 指到 1 号端口（进程内替身，不碰开发机 6379）、`app.scheduling.enabled=false`、工作区状态文件指到临时目录。测试不要读用户的 `~/.zhiqu/`。
- 限流默认开（`RateLimitFilter`）：登录 12 次/分、AI 写 40、其它 180。脚本化端到端测试注册很多用户会撞 429。
- **新判据要见过红才算数**：扰动源码，确认它红；再看是 `Failures`（断言说话）还是 `Errors`（上下文塌了，断言根本没跑）。扫空和扫干净在报告里长得一样。经过见 `docs/notes/testing.md`。
- `-Dtest=A+B` 不是多类语法：surefire 一条都不跑，还报 BUILD SUCCESS。

## 前端

- 每页是 `assets/pages/<页>.js` 的 ES 模块，壳按 `PAGE_MODULES` 加载：模块导出 `boots[页面](zqShared)`，可选导出 `dayReload`；模块顶层只许有声明。壳给模块的东西只走 `zqShared`。
- **改了 `static/` 下任何文件就换缓存令牌**：所有 HTML 的 `?v=` 和 `service-worker.js` 的 `ZHIQU_CACHE` 一起换。现在是 `20261111-r128d`。一致性由 `StaticAssetCacheTokenTest` 钉着；不换测试不会红，但用户会继续拿旧缓存。
- 新加一个 HTML 页面：`SecurityConfig` 的放行清单、`service-worker.js` 的 `CORE_ASSETS`、`PAGE_MODULES` 都要加。漏了放行，没登录时打开是空白 403（`MiniPomodoroTest` 钉着）。
- 样式：设计令牌只在 `assets/zhiqu-ui.css` 的 `:root` 定义一次（引用不存在的 `var()` 会让整条声明作废，不报错）；手机样式只有一段 `@media (max-width: 760px)`，放在最后。内联样式和写死的字号按文件只许降（`InlineStyleRatchetTest` 用 `==` 钉着）。字要细：正文 400、标题和主按钮 500，600 只给品牌标志和加粗（`DesignTokensTest`）。
- 图标只用 `zhiqu-ui.js` 的 `ICONS`，不用 Unicode 符号当图标（`IconSetTest`）。悬停说明照样写 `title`，由 `setupTips` 画成提示（WKWebView 不显示原生 `title`）；只有图标的按钮另给 `aria-label`。
- 页面头部一律 `<header class="zq-page-head">`：标题 + 一行 `.zq-page-sub` 在左、`.zq-page-actions` 在右（`PageHeadTest`）。
- 页面一打开就露出骨架，数据到了填进去；只有后台页和旧地址跳转页先遮着。文字一律系统无衬线字体，不从外网取字体 / 样式表；数字用 `.zq-num`，等宽字体只给代码。
- 业务错误是 HTTP 200 + `code != 200`，前端判 `result.code === 200`。写请求走 `request()`（去重、幂等键、重试），不要直接 `fetch`（`RequestResilienceTest`）。页面不带示例数据，静态 HTML 里不写死数字。
- 桌面应用是 WebKit（WKWebView），内置浏览器是 Chromium：样式能力按 `CSS.supports` 选择，别固定假定 WKWebView 不支持；样子要在 WebKit 里量（`DesktopWebKitLayoutTest`）。
- 界面改了，首页轮播的截图要重出（浅、深两套，用法在 `deploy/desktop/shots/seed-demo.js` 开头）。截图要开窗口，跑之前问用户（`HomeCarouselTest` 钉着）。

## 改一处，要同时改哪几处

- **AI 的模型请求**：每一处 OpenAI 兼容请求都要 `applyOpenAiReasoningOptions`（干活的轮传 `"OFF"`，DeepSeek 不说就默认思考），输出上限走 `OutputLimits`。新加一处会让 `ModelRequestThinkingTest` 红。
- **管理员接口**：每个方法第一句 `requireAdmin()`（`SecurityConfig` 没有按角色的规则，`AdminAuthorizationTest` 钉着）。个人访问令牌 `zqp_…` 只在 `/api/harness/**` 被认。
- **写接口**：默认认 `Idempotency-Key`（`IdempotentWriteAspect`）；不认的在 `IdempotentWriteIntegrationTest` 里一个个列着，新加回 Cookie 的写接口会让它红。
- **「今天」**：服务端只有 `BusinessClock.today()`（`src/main/java` 里不许裸 `LocalDate.now()`、不许写死 `ZoneId.of`），前端只有 `today()`（不许 `toISOString()`，也不许拿 `localDate()` 当今天）。
- **工作区路径 / 命令规则**：`conformance/workspace-rules.json` 同时被 `WorkspaceRulesConformanceTest`（Java）和 `zhiqu-cli/test/conformance.test.js` 读；两边各自绿不算数，对同一份输入给出同样结论才算数。文本替换同理走 `conformance/text-edit.json`。
- **「下发什么工具」=「能执行什么工具」**：必须是同一份清单，每轮重算。
- **执行顺序**：只有 `AgentPosition` 一个出处；图的 `priority` / `parallelGroupId` / `dependsOn` 是推导的，不要手写。
- **新迁移**：下一个空号、只做加法；实体 / Mapper / DTO 一起看。
- **首页截图**：见上，界面一改就要重出。

## 不能碰的边界

- **AI 写的东西一律先成草稿**：计划、任务、例行计划、长期记忆、Wiki 改动、代码改动，只有用户确认（`POST /api/ai/artifacts/{id}/confirm`；Wiki 走 `upsertRevisionPage`）才落地。唯一例外：代码工作区 auto 档的 `shell` 直接落盘，`edit_file` / `write_file` 仍是草稿。
- **代码工作区默认关闭，这个默认值本身就是安全边界**：档位 `OFF / READ / WRITE / EXEC`，认不出回落 `OFF`；生效要同时满足档位非 `OFF`、根目录存在、`server.address` 是回环地址。工作区接口第一句是 `requireLocal()`（只认本机请求，挡 DNS 重绑定和反向代理）。生产 profile 一律拒绝。
- **`app.crypto.master-key` 一换，已有密文（AI 的 key、Wiki 正文、任务标题）就解不开**；连同一个库的几个后端必须用同一把（`CryptoKeyCanary` 对不上不启动）。
- **密钥只走环境变量，不提交真 key**（`NoCommittedSecretsTest`）；生产配置里 `CHANGE_ME_` 没填就不启动（`StartupSecretGuard`）；生产模板要覆盖 `application.yml` 的每个键（`ProdConfigParityTest`）。
- **网页抓取的 SSRF 校验放在真正发请求的那一层**，`app.ai.web-fetch.block-private-network=true` 保持。
- **模型 API 地址允许本机、内网和内部域名**（用户明确要求），只校验 HTTP(S) URL 和主机；别把限制加回来。
- 不要擅自启动桌面应用去碰用户的真实数据；验证用的数据在 `zhiqu_verify` 库。
- **检出不要挪回 `~/Desktop` / `~/Documents`**：iCloud 会往 `src/` 里丢 `X 2.java` 这类冲突副本，`SourceTreeCleanlinessTest` 会让构建失败。

## 容易再踩的坑

- **Spring 不认识的配置键不报错**。写一个属性之前先确认它存在：定时任务开关是 `app.scheduling.enabled`，`spring.task.scheduling.enabled` 是假的（曾经写在 27 个测试里）。
- **有 `@Version` 的表不要「读整行 → 改 → `updateById`」**：别人动过就写进 0 行、接口照样回成功；`updateById` 还会跳过 null。只改自己那几列并检查行数。
- 请求线程里写一行「进行中」、做完再改终态：要么挂心跳（`StreamLiveness`），要么有租约。只看「是不是这个进程启动之前建的」不行（几个后端共用一个库）。`SecurityContext` 不会传到异步线程：工具执行器显式传 `userId`。
- 流式请求里的「启动就炸」其实炸在每一次请求里：装配窗口（`beginRun` 之后、各相位之前）要自己 try（记日志、`errorRun`、`failAssistantMessage`）。
- Wiki 写页要带客户端 `version`（乐观锁）：不带给「缺少知识页版本」，旧值给「已被其他窗口修改」。用户保存的正文原样存，`MarkdownCanonicalizer.clean()` 只给 AI 写的和哈希。
- 模块顶层只许有声明；`PAGE_MODULES` 拼错或模块少导出，页面一片空白，打开那一页才炸。
- 命令行：不用全局 `fetch`，也不用 `import 'node:http'`（会把 tls 拉进来，每次多等一两秒）；子进程不继承环境变量；超时杀整个进程组。
- 测试进程：`kill(pid, 0)` 对僵尸进程也说「在」；漏掉的孙子进程会攥着管道，让读取一直等下去。

## 文档与每一轮

- 每轮开工时把计划存进 `docs/rounds/round-NN.md`，收口时补结果，随那一轮一起提交；再在 `docs/rounds/README.md` 和 `CLAUDE.md` 末尾各加一行。`ClaudeMdTest` 钉着：`CLAUDE.md` ≤ 200 行、里面写到的路径和判据都存在、每一轮两份都有行。
- 进行中的计划：`docs/product-plan.md`、`docs/zhiqu-harness-plan.md`、`docs/codex-parity-plan.md`、`docs/ui-plan.md`、`docs/mini-pomodoro-plan.md`。标「要你定」的先问用户；装 Codex、花钱的对比、真模型评测，先问用户。
- 各主题的细节：`docs/notes/backend.md`、`frontend.md`、`ai-assistant.md`、`wiki-and-shared-plans.md`、`code-workspace.md`、`cli.md`、`desktop.md`、`testing.md`、`configuration.md`、`dev-environment.md`。
- issue 在 GitHub `3435986347-spec/zhiqu-StudySystem`，用 `gh` 操作；分诊标签和领域文档约定见 `docs/agents/`。
- 改规矩时先改 `CLAUDE.md`（受 200 行限制，细节挪进 `docs/notes/`），再同步这份文件里对应的那一句；别让两份各说一套（`zhiqu` 只读这份，Claude Code 读那份）。
