# CLAUDE.md

给在这个仓库里干活的 Claude Code 看的规矩：怎么跑、怎么测、不能碰的地方、几条踩过就会再踩的坑。
来龙去脉和各部分的细节在 `docs/`：各部分的说明在 `docs/notes/`，每一轮一份 `docs/rounds/round-NN.md`。
（第三十八轮从 1529 行压到这里，原来的内容一字不改地挪进了那两处；`ClaudeMdTest` 管着这份不超过 200 行。）

## 这是什么

**知趣·象限 AI 办公助手** —— 以四象限（艾森豪威尔）为骨架的个人 AI 办公助手，带个人知识 Wiki 和可选的语义检索（RAG）。
2026-10-04 之前是给大学生的学习系统（第二十六轮改的定位）；内部名字 `StudyTask`、`study_record`、`create_study_plan` 故意没改。
一个后端，三个入口：网页（Spring Boot 带着静态前端，**前端没有构建步骤**）、桌面应用（macOS 原生外壳 / Windows jpackage）、
npm 版命令行 `zhiqu`（`zhiqu-cli/`，循环与工具跑在用户电脑上，服务端只做登录、模型网关、存档、远程工具）。

## 怎么跑

库结构由 Flyway 管（`zhiqu-backend/src/main/resources/db/migration`，现在到 `V43`），启动时自动迁移，**不要手动执行 `schema.sql`**。只需要库存在：

```sql
CREATE DATABASE zhiqu_db DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_general_ci;
```

加迁移用下一个空号 `V<n>__description.sql`，只做加法（新的可空列 / 新表），老数据照样合法。

```bash
cd zhiqu-backend
mvn clean package -DskipTests
java -jar target/zhiqu-backend-0.0.1-SNAPSHOT.jar
```

- Windows：`mvn clean package "-DskipTests"`、`java -jar target\zhiqu-backend-0.0.1-SNAPSHOT.jar`。`mvn spring-boot:run` 也行。访问 `http://localhost:8080`。
- 这台机器默认的 JDK 太新，Lombok 编不过：`export JAVA_HOME=/Users/hmz/Library/Java/JavaVirtualMachines/temurin-17.0.20.1/Contents/Home`。
- 本地常用：`--server.port=18080`、`--app.rag.enabled=false`（不连 RAG 旁路）；模型配置可直接指向本机的假模型。
- **停本地实例按端口，不按进程名**（`pkill -f java` 会带走 IDE）：`kill $(lsof -nP -iTCP:8080 -sTCP:LISTEN -t)`。
- **检出不要挪回 `~/Desktop` / `~/Documents`**（iCloud 往 `src/` 里丢 `X 2.java`、`zhiqu-api 2.js` 这类冲突副本；`SourceTreeCleanlinessTest` 会让构建失败）。经过见 `docs/notes/dev-environment.md`。
- 桌面应用：`bash deploy/desktop/package-macos-native.sh`（Windows 版 `package-windows.ps1` 只能在 Windows 上打）。**外壳（Swift）的改动要重新打包才到用户手里**，网页的改动不用。

## 怎么测

```bash
cd zhiqu-backend
mvn -o test                          # 第一次联网跑要先取 junit-platform-launcher
mvn -o test -Dtest=WikiToolGuardTest
mvn -o clean test                    # 改了任何 public 构造器 / 方法签名之后必须 clean（增量编译不重编没改的调用方）
cd ../zhiqu-cli && npm test
```

- 集成测试要 Docker（Testcontainers）。**没有 Docker 时静默跳过**：`Tests run: N, Skipped: N` 不是通过。显式跳过写 `-Dzhiqu.skipDockerTests=true`；开 Docker：`open -a Docker`。
- 前端行为判据跑在 node 上，直接加载发布的那份实现（不在 Java 里重写一份）。没有 node 显式失败；`-Dzhiqu.nodePath=<绝对路径>` 指位置，`-Dzhiqu.skipNodeTests=true` 显式跳过。
  node 把超时记成 `cancelled` 而不是 `fail`。
- 测试用的 Redis 指到 1 号端口（进程内替身，不碰开发机的 6379），定时任务用 `app.scheduling.enabled=false` 关 —— 都在 `src/test/resources/application.properties`。
- 限流（`RateLimitFilter`：登录 12 次 / 分钟、AI 写操作 40、其它 180）会拦住脚本化的端到端测试；开很多用户时注意。

### 判据的纪律（每一条都吃过亏，经过见 `docs/notes/testing.md`）

1. **新判据要见过红才算数**：扰动源码、看它红。绿可能是「看了，没毛病」，也可能是「什么都没看到」，代码里两者长得一样。
2. **确认扰动真的落了**：跑之前 `grep -c` 被删的那句、不是 0 就不跑；`grep -c` 别用 `&&` 串（计数为 0 时退出码是 1）。
3. 对源码断言之前去掉注释（`SourceText`）；扫描要有下限（扫空和扫干净长得一样）；计数类判据要求 `== 1` 这样的正数，不要「不超过 1」。
4. 扰动的备份放在 `src/` 外面（`static/` 下的东西会被打进 JAR）；恢复用 `cp` + `touch`（`cp -p` 带回旧的修改时间，增量编译会留着上一个扰动的 class），最后 `clean` 全量。
5. 扰动在干净基线全绿之后再跑。一次只动一个变量（对比基线时，两个检出在同一个卷、同一类目录下）。对照组不死的实验不作数。
6. 一个断言绿着，可能是别的防护替它挡了：两道防护各自要有只有它能照出来的样本。
7. 搬代码之前拿字面量对一遍 `src/test`，再看哪些判据对源码跑正则；`assertFalse` 一类的判据在代码搬走后会自动变绿。
8. 扰动推翻了写判据时的那个理由，就改理由。
9. shell 是 zsh：`for f in $FILES`、`set -- $pair` 不分词，用数组。

## 进行中的计划

- 产品方案（2026-10-03）：[`docs/product-plan.md`](docs/product-plan.md)，五步按顺序做，标「要你定」的先问用户。
- zhiqu harness（P0–P7）：[`docs/zhiqu-harness-plan.md`](docs/zhiqu-harness-plan.md)，严格按表执行、不擅自增删，做完一项更新「进度」列。**npm 发布（P7）之前单独问用户**；`zhiqu-cli/package.json` 的 `"private": true` 留着。
- 界面打磨（2026-10-06）：[`docs/ui-plan.md`](docs/ui-plan.md)，「要你定」的三件用户已定（见那份末尾）；每一步做完给用户截图。
- 迷你番茄钟（2026-10-09 用户定了）：[`docs/mini-pomodoro-plan.md`](docs/mini-pomodoro-plan.md)，只做 macOS 桌面应用，三步一步一轮（第四十九到五十一轮做完；面板还没在屏幕上开过，看之前问用户）；宠物形态是后话。
- 一轮接一轮：每轮的计划开工时存进 `docs/rounds/round-NN.md`，收口时补结果，随那一轮一起提交，并在 `docs/rounds/README.md` 和本文件末尾各加一行。每轮带一段真浏览器里的暴力测试。

## 不能碰、不能绕的地方

- **代码工作区默认关闭，这个默认值本身就是安全边界**。档位 `OFF / READ / WRITE / EXEC`，认不出的值回落 `OFF`；生效要同时满足：档位不是 `OFF`、根目录存在、`server.address` 是回环地址（没配置算「不是」）。
  工作区的接口和 code agent 读工作区都要管理员。EXEC 不是沙箱：唯一真正的安全判定是禁用行内代码开关（只能运行用户看过的文件）；生产 profile 一律拒绝；子进程不继承环境变量。见 `docs/notes/code-workspace.md`。
- **AI 写的东西一律先成草稿**：计划、任务、例行计划、长期记忆、Wiki 改动、代码改动。只有用户确认（`POST /api/ai/artifacts/{id}/confirm`；Wiki 走 `upsertRevisionPage`）才落地。
  「下发给模型的工具」和「能执行的工具」必须是同一份清单。
- **`app.crypto.master-key` 一换，已有密文（AI 的 key、Wiki 正文、任务标题）就解不开**。连同一个库的几个后端必须用同一把（`CryptoKeyCanary` 对不上就不启动）。
- **「今天」只有一个出处**：服务端 `BusinessClock.today()`（`src/main/java` 里不许有裸 `LocalDate.now()`、写死的 `ZoneId.of`），前端 `today()`（不许用 `toISOString()`，也不许拿 `localDate()` 当今天）。
- **管理员接口每个方法第一句都是 `requireAdmin()`**（`SecurityConfig` 里没有按角色的规则，`AdminAuthorizationTest` 钉着）。个人访问令牌 `zqp_…` 只在 `/api/harness/**` 被认。
- **写接口默认认 `Idempotency-Key`**（`IdempotentWriteAspect`）；不认的在 `IdempotentWriteIntegrationTest` 里一个一个列着，新加的回 Cookie 的写接口会让它红。
- **网页抓取的 SSRF 校验放在真正发请求的那一层**，不放在调用方。`app.ai.web-fetch.block-private-network=true` 保持。
- **模型 API 地址允许本机、内网和内部域名**（用户 2026-10-13 明确要求取消限制，第五十九轮）；只校验合法的 HTTP(S) URL 和主机，不再需要 `app.ai.allow-private-provider-url`。
- **执行顺序只有 `AgentPosition` 一个出处**：图的 `priority` / `parallelGroupId` / `dependsOn` 是推导出来的，不要手写。runner 不覆写 `announceAt` / `commitAt` 就等于 `runAt`，一个 runner 默认占三个槽。
- **密钥只走环境变量，不提交真 key**（`NoCommittedSecretsTest`）；生产配置里 `CHANGE_ME_` 没填就不启动（`StartupSecretGuard`）。
- 生产配置是**替换**不是追加：`application.yml` 的每个键在生产模板里都要有（`ProdConfigParityTest`）。
- 不要擅自启动桌面应用去碰用户的真实数据；验证用的数据在 `zhiqu_verify` 库里，留给用户删。

## 前端的规矩

- 静态文件在 `zhiqu-backend/src/main/resources/static/`。`assets/zhiqu-api.js` 是共用层（请求、登录与共享登录、业务时钟、草稿、页面提醒、番茄钟（全站一个钟 + 待补记）、任务表单、Markdown、设置弹窗的路由、`openModal`）。
  每一页是 `assets/pages/<页>.js` 的 ES 模块，`route()` 按 `PAGE_MODULES` 加载：模块导出 `boots[页面](zqShared)`，可选导出 `dayReload`；壳给模块的东西只走 `zqShared`；**模块顶层只许有声明**（`PageModulesTest`）。
- **改了任何静态资源就换缓存令牌**：所有 HTML 的 `?v=` 和 `service-worker.js` 的 `ZHIQU_CACHE` 一起换（`StaticAssetCacheTokenTest`）。现在是 `20261014-wiki-plan`。
- **一套中性配色**（第四十、四十一轮）：`:root` 是浅色 + 黑白强调，`html[data-zq-mode="dark"]` 是深色，`data-zq-accent="gold"` 换成金色（可选）；外观默认跟随系统（`zq.theme`），每页头上同一行内联脚本先定明暗。
  浅深两块定义同一批颜色令牌，对比度按样式表的值算、≥ 4.5 : 1；字阶 / 间距 / 字重用 `--zq-fs-*` / `--zq-sp-*` / `--zq-fw-*`，**内联样式也不写死字重**；
  字要细（用户要「像 Claude 那样」）：正文 400、标题和主按钮 500，600 只给品牌标志和加粗（`DesignTokensTest`）。
  图标只用 `zhiqu-ui.js` 的 `ICONS`（`ZQUI.icon` / `data-zq-icon` / `zqShared.icon`），不用 Unicode 符号当图标（`IconSetTest`）。界面打磨的步骤见 `docs/ui-plan.md`。
  页面头部一律 `<header class="zq-page-head">`：标题 + 一行 `.zq-page-sub` 在左、`.zq-page-actions` 在右，标题上面不加小字（`PageHeadTest`）。
  AI 助手的输入区、消息、开关按下的样子都在样式表（`.zq-composer` / `.zq-msg` / `.zq-chip[aria-pressed]`），JS 只管类和 `aria-*`（`AiComposerTest`）。
  悬停说明照样写 `title`：`zhiqu-ui.js` 的 `setupTips` 把它画成提示（**桌面应用的 WKWebView 不显示原生的 `title`**）；只有图标的按钮另给 `aria-label`。
- **界面改了，首页轮播的截图要重出**（浅、深两套，用法在 `deploy/desktop/shots/seed-demo.js` 开头；`Snapshot` 要在屏幕上开一个窗口才截得出来 —— 跑之前问用户）。
  第二十六轮的四张在改版后一直没换，直到用户自己发现（第四十六轮，`HomeCarouselTest`）。
- **桌面应用是 WebKit（WKWebView），内置浏览器是 Chromium**：只有 Chromium 认的写法（`appearance: base-select`）在桌面应用里是另一副样子；样子要在 WebKit 里量（`DesktopWebKitLayoutTest`，不开窗口）。
- 设计令牌只在 `assets/zhiqu-ui.css` 的 `:root` 定义一次：引用不存在的 `var(--x)` 不报错，整条声明作废（`FrontendTokenAndDateTest`）。手机样式只有一段 `@media (max-width: 760px)`，必须在 `zhiqu-ui.css` 最后。
- 业务错误是 HTTP 200 + `code != 200`，前端判 `result.code === 200`。写请求走 `request()`（去重、幂等键、重来、照实说「不确定」），不要直接 `fetch`（`RequestResilienceTest`）。
- 页面不带示例数据、静态 HTML 里不写死数字（`InitErrorReplacesDemoContentTest`）。细节：`docs/notes/frontend.md`。
- 新加一个 HTML 页面：`SecurityConfig` 的放行清单、`service-worker.js` 的核心资源、`PAGE_MODULES` 都要加 —— 漏了放行，没登录时打开是一片空白的 403（第五十轮，`MiniPomodoroTest` 钉着）。
- **页面一打开就露出自己的骨架**，数据到了填进去；只有后台页和旧地址的跳转页先遮着（`zhiqu-ui.js` 的 `holdsUntilBoot`）。页面之间用 `@view-transition` 交叉淡化、侧栏不动。
  文字一律系统无衬线字体，**不从外网取字体 / 样式表**（挡渲染也挡脚本，网络慢时整页等着）；数字用 `.zq-num`（等宽数位），等宽字体只给代码。见 `PageSwitchSmoothnessTest`、第三十九轮。

## 踩过就会再踩的坑

- **Spring 不认识的配置键不报错**：`spring.task.scheduling.enabled` 写在 27 个测试里，等于没写。写一个属性之前先确认它存在。
- **有 `@Version` 的表不要「读整行 → 改 → `updateById`」**：中间有人动过这一行就写进 0 行，接口照样回成功；`updateById` 还会跳过 null（清空的字段写不进去）。只改自己那几列，并检查行数。
- 请求线程里写一行「进行中」、做完再改终态的东西：要么挂心跳（`StreamLiveness`，由 `InterruptedWorkRecovery` 收拾），要么有租约。只看「是不是这个进程启动之前建的」不行（几个后端共用一个库）。
- `SecurityContext` 不会传到异步线程：工具执行器显式传 `userId`。
- **DeepSeek 不说就默认思考**：发给模型的每一处 OpenAI 兼容请求都要 `applyOpenAiReasoningOptions`（干活的轮传 `"OFF"`），新加一处会让 `ModelRequestThinkingTest` 红；写回答的输出上限走 `OutputLimits`（和命令行同一档、不收就降）。
- 流式请求里的「启动就炸」其实炸在每一次请求里：装配窗口（`beginRun` 之后、各相位之前）要自己 try（记日志、`errorRun`、`failAssistantMessage`）。
- 搬代码会让判据扫错文件，而扫错文件的判据看起来和通过一模一样：判据要读那条性质现在所在的文件。
- 桌面应用：工作目录是 `/`（相对路径的上传目录写不进去）；WKWebView 不实现代理方法就不做事，也不报错；jlink 要带 `jdk.charsets` / `jdk.crypto.ec`。见 `docs/notes/desktop.md`。
- 命令行：不用全局 `fetch`，也不用 ESM 的 `import 'node:http'`（会把 tls 拉进来，每次多等一两秒）；子进程不继承环境变量；超时就杀整个进程组。见 `docs/notes/cli.md`。
- 测试进程：`kill(pid, 0)` 对僵尸进程也说「在」；漏掉的孙子进程会攥着管道，让读取一直等下去。

## 各部分的说明在哪

- 后端的包（`common/`、`security/`、`config/`、`controller/ → service/ → mapper/`、`entity/`、`rag/`）、权限、登录、RAG：`docs/notes/backend.md`；配置项：`docs/notes/configuration.md`。
- AI 助手（流式、多 agent 的执行图、计划草稿、记忆、校验，拆 `AiServiceImpl` 的经过）：`docs/notes/ai-assistant.md`。
- 知识 Wiki（乐观锁、草稿基线）与参考计划（审核、驳回原因存两份）：`docs/notes/wiki-and-shared-plans.md`。
- 代码工作区与限额边界：`docs/notes/code-workspace.md`。命令行与服务端网关：`docs/notes/cli.md`。桌面应用：`docs/notes/desktop.md`。
- 前端：`docs/notes/frontend.md`。测试的故事：`docs/notes/testing.md`。开发环境（含 iCloud 那段历史）：`docs/notes/dev-environment.md`。
- RAG 旁路的启动与验证：`rag-service/README.md`（连不上时后端自己退回关键词检索）。领域文档：`CONTEXT.md` + `docs/adr/`。
- issue 在 GitHub `3435986347-spec/zhiqu-StudySystem`，用 `gh` 操作；分诊标签、领域文档的约定见 `docs/agents/`。

## 每一轮（一轮一行，经过在链接里）

- [第二轮](docs/rounds/round-02.md) 网页请求超时与重试、聊天流心跳、Wiki 打开变快
- [第三轮](docs/rounds/round-03.md) 提醒按业务时钟、渠道超时、成就用 COUNT、统计趋势
- [第四轮](docs/rounds/round-04.md) 日期区间有上限、首页只取用得到的任务、参考计划计数只改一列
- [第五轮](docs/rounds/round-05.md) 改密码吊销旧令牌、登录不泄露用户名是否存在
- [第六轮](docs/rounds/round-06.md) 用户这一行只改自己那几列、换头像删旧文件、截断要说出来
- [第七轮](docs/rounds/round-07.md) 没有 Redis 时锁与幂等退回进程内
- [第八轮](docs/rounds/round-08.md) 套用只执行一次、一次请求写多少行有上限
- [第九轮](docs/rounds/round-09.md) 复杂任务、长输入、一次做对；命令行输入框不闪
- [第十轮](docs/rounds/round-10.md) 网页 code agent 一次做对、写完查语法、桌面启动快一半
- [第十一轮](docs/rounds/round-11.md) 暴力测试：全接口坏输入
- [第十二轮](docs/rounds/round-12.md) 命令行只说结论、不空转、用满窗口
- [第十三轮](docs/rounds/round-13.md) 暴力测试：并发、狂刷新、Ctrl+C
- [第十四轮](docs/rounds/round-14.md) 暴力测试：真浏览器连点、乱序响应
- [第十五轮](docs/rounds/round-15.md) 不丢字：草稿、登录过期回原页
- [第十六轮](docs/rounds/round-16.md) 命令行：坏掉的本地状态、奇怪的文件
- [第十七轮](docs/rounds/round-17.md) 数据量的极端：用了两年的账号
- [第十八轮](docs/rounds/round-18.md) 命令行的数据量极端
- [第十九轮](docs/rounds/round-19.md) 模型那一侧不配合
- [第二十轮](docs/rounds/round-20.md) 显示的极端：手机、放大、窄终端
- [第二十一轮](docs/rounds/round-21.md) 时间的极端：时区、跨零点、时钟跳
- [第二十二轮](docs/rounds/round-22.md) 网络与服务器的极端：回应丢了、半路重启、断网
- [第二十三轮](docs/rounds/round-23.md) 新用户走一遍主流程（方案第 1 步）
- [第二十四轮](docs/rounds/round-24.md) 删旧前端、示例数据、Java 版命令行（方案第 2 步）
- [第二十五轮](docs/rounds/round-25.md) 模型判断出不出计划、页面提醒、标签页共享登录
- [第二十六轮](docs/rounds/round-26.md) 定位落地：AI 办公助手（方案第 3 步）
- [第二十七轮](docs/rounds/round-27.md) AI 读得到任务（带开关）
- [第二十八轮](docs/rounds/round-28.md) 几个后端连同一个库：主密钥哨兵、心跳、按天认领
- [第二十九轮](docs/rounds/round-29.md) 命令行接上任务、`zhiqu mcp`
- [第三十轮](docs/rounds/round-30.md) 头像菜单与设置弹窗（方案第 4 步开始）
- [第三十一轮](docs/rounds/round-31.md) 后台四页拆成模块，立起页面模块的形状
- [第三十二轮](docs/rounds/round-32.md) 例行计划、专注统计拆成模块
- [第三十三轮](docs/rounds/round-33.md) 参考计划拆成模块
- [第三十四轮](docs/rounds/round-34.md) 任务页拆成模块
- [第三十五轮](docs/rounds/round-35.md) 看板拆成模块
- [第三十六轮](docs/rounds/round-36.md) 知识 Wiki 拆成模块
- [第三十七轮](docs/rounds/round-37.md) AI 助手拆成模块（方案第 4 步做完）
- [第三十八轮](docs/rounds/round-38.md) CLAUDE.md 瘦身（方案第 5 步）
- [第三十九轮](docs/rounds/round-39.md) 页面切换流畅：骨架先露、互不依赖的请求一起发、文字一律系统无衬线字体
- [第四十轮](docs/rounds/round-40.md) 界面打磨第 1 步：设计令牌、白天白晚上黑（跟随系统）、金色 / 黑白强调
- [第四十一轮](docs/rounds/round-41.md) 第 1 步的调整：默认黑白、字更细（像 Claude）、内联字重收成令牌
- [第四十二轮](docs/rounds/round-42.md) 界面打磨第 2 步：Unicode 符号换成一套线性图标
- [第四十三轮](docs/rounds/round-43.md) 界面打磨第 3 步：页面头部一种写法、侧栏收起按钮做小；AI 助手一种底色
- [第四十四轮](docs/rounds/round-44.md) 界面打磨第 4 步：AI 助手的输入框、两侧面板的图标开关、消息排版
- [第四十五轮](docs/rounds/round-45.md) `search_wiki` 认页面类型（命令行找不到「目标」页）、悬停提示自己画、Wiki 目录头不叠字
- [第四十六轮](docs/rounds/round-46.md) 首页轮播：新界面的截图（浅 / 深各一套、跟着页面换），页签 + 淡入淡出，功能卡片换图标
- [第四十七轮](docs/rounds/round-47.md) review 推送前的 26 个提交：改任务状态也跟着开关、拖偏的文件不被打开、汇报认领失败放回、提示的几处
- [第四十八轮](docs/rounds/round-48.md) 界面打磨第 5 步：看板（一天一格的日历、点一天看那天、四象限一张卡）；修了没填时间的例行计划让看板打不开
- [第四十九轮](docs/rounds/round-49.md) 迷你番茄钟第 1 步：番茄钟全站共用一个钟（存在 localStorage、侧栏「专注中」、到点只记一次）；首页轮播的看板截图换新
- [第五十轮](docs/rounds/round-50.md) 迷你番茄钟第 2 步：`mini.html`，半透明的深色胶囊（倒计时、开始 / 暂停、任务、第几轮、展开）；新页面漏了放行是空白 403
- [第五十一轮](docs/rounds/round-51.md) 迷你番茄钟第 3 步：macOS 外壳的悬浮面板（不抢焦点、总在最前、中间拖、记位置），看板上「缩小到桌面」
- [第五十二轮](docs/rounds/round-52.md) 界面打磨第 6 步：任务页（一行工具条、服务端搜索加密的标题、列宽只写一处、窄窗口和手机不横着滚）
- [第五十三轮](docs/rounds/round-53.md) 用户在桌面应用里看到的：日历日期出格（窄了换竖排）、番茄钟下拉撑出卡片、下拉是原生样子；在 WebKit 里量的判据
- [第五十四轮](docs/rounds/round-54.md) AI 助手在桌面应用里一问要等几分钟：工具轮 / 拆计划 / 看图没说不要思考（DeepSeek 默认想）；回答的输出上限 4096 → 16384；代码模式不改写检索
- [第五十五轮](docs/rounds/round-55.md) 界面打磨第 7 步：知识 Wiki 的正文（一行 42 字、15px、标题分层、重复的页名读时藏起）、一行图标工具栏；Markdown 的样子从内联挪进样式表；任务页的行和勾选项重名
- [第五十六轮](docs/rounds/round-56.md) 界面打磨第 8 步（一）：例行计划页（「今天」+「全部」两块，新建 / 从任务生成是弹窗、同一套设置；不该给的「标记完成」去掉）
- [第五十七轮](docs/rounds/round-57.md) 界面打磨第 8 步（二）：参考计划（一行工具条、详情用 openModal、点赞后照原筛选）、专注统计（零不写数、日期挤了隔一根写）；「♡」换图标
- [第五十八轮](docs/rounds/round-58.md) review 推送前的 9 个提交：点正文编辑时字不跳、迷你窗再缩小重新载入、「参数不认」不降着重试、搜索上限照服务端说
- [第五十九轮](docs/rounds/round-59.md) 模型 API 地址可指向本机、内网和内部域名，保留 HTTP(S) URL 格式校验
- [第六十轮](docs/rounds/round-60.md) 知趣 CLI + DeepSeek 全量 HumanEval：156/164（95.12%），固定协议、隔离执行与逐题报告
- [第六十一轮](docs/rounds/round-61.md) 仓库级评测设计：固定 SWE-bench Verified 10 题、真实 CLI 与独立官方评分，Java / JS 补充集单列；未开始付费运行
- [第六十二轮](docs/rounds/round-62.md) 仓库评测准备工具与 ¥50 配置；公司禁止下载 Docker，转个人电脑继续，真实模型0次 / ¥0，隔离与官方评分尚待验收
- [第六十三轮](docs/rounds/round-63.md) 计划完整草稿到达即确认、来源记录与正文预览、Wiki 写入以真实 PENDING 回执汇报；连点与乱序请求防重
