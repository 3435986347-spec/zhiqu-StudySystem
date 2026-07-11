# 知趣·象限学习系统

知趣·象限学习系统是一套面向学习、备考、工作计划和长期目标管理的 Web 应用。系统以“今日/本周行动台 + 任务/例行计划 + AI 助手 + 知识 Wiki”为核心，帮助用户把零散想法、文件、DDL、复习计划和长期知识沉淀成可执行、可提醒、可复用的个人计划系统。

当前项目采用 **Spring Boot 单体架构**：后端 API、静态前端页面、PWA 资源和管理后台都打包在同一个 JAR 中，不需要单独部署前端项目。

## 主要功能

| 模块 | 说明 |
| --- | --- |
| 登录与账号 | 注册、登录、JWT/Cookie 鉴权、记住账号、个人资料、头像上传 |
| 学习看板 | 今日概览、本周日历、临近 DDL、例行计划完成度、四象限摘要 |
| 任务管理 | 创建、编辑、删除任务，支持 DDL、优先级、状态、象限、乐观锁版本控制 |
| 例行计划 | 适合每天背单词、每周复盘、固定训练等重复事项，不把日常计划展开成大量任务 |
| 早八提醒 | 每天 08:00 汇总临近 DDL 和当天例行计划，支持 PushPlus 等外部提醒渠道 |
| AI 助手 | 多模型切换、流式对话、深度思考（可折叠）、Markdown/表格/公式渲染；Notebook 资料工作区支持 PDF/Excel/文本切块和图片存档；顺序 Agent/TaskGraph 提供执行轨迹、Claim/Evidence、Verifier 与可确认产物；支持计划生成及任务/例行计划写入 |
| 模型配置 | 支持系统模型与个人模型，个人中心可添加 OpenAI-compatible、Anthropic、Gemini、Ollama、vLLM 等配置，附连通性/能力测试 |
| 知识 Wiki | Obsidian/Karpathy 风格个人知识空间，Raw Source、Patch Set、Wiki Pages、index/log、双链、图谱、健康检查；文档视图支持所见即所得编辑、公式块（本地 KaTeX）、参考链接、右键删除、整站 Markdown 导出 |
| 参考计划 | 用户可提交计划模板，后台审核后发布，其他用户可按开始日期套用到自己的学习日历 |
| 成就系统 | 根据学习记录、任务完成、连续天数等自动解锁成就 |
| 监管后台 | 查看流量、账号、反馈、运行异常、参考计划审核等运营与安全信息 |
| 运行异常收集 | 前端运行错误、接口异常可上报到后台，便于排查线上问题 |
| 高并发基础 | Redis 限流、幂等 key、乐观锁、事务、提醒抢占、死锁重试等生产级基础保护 |

## 技术栈

后端：

- Java 17
- Spring Boot 3.3.5
- Spring Security
- MyBatis-Plus
- MySQL 8
- Redis
- Flyway
- Maven

前端：

- 原生 HTML / CSS / JavaScript，无构建步骤，静态文件内嵌在 Spring Boot JAR 中
- 统一 UI 皮肤 `assets/zhiqu-ui.css`（5 套配色 × 浅/深主题，CSS 变量驱动）
- 统一接口适配层 `assets/zhiqu-api.js`（JWT 自动附带、Claude 风格弹窗/通知、Markdown/表格/公式渲染、各页 boot 逻辑）
- 侧边导航与主题切换 `assets/zhiqu-ui.js`
- KaTeX 本地内置（`assets/vendor/katex/`，公式离线渲染，不依赖外网 CDN）
- PWA Manifest / Service Worker（外壳资源与字体预缓存，支持离线）

部署：

- Windows Server
- 可执行 Spring Boot JAR
- MySQL 8
- Redis / Memurai
- Caddy 反向代理与 HTTPS
- WinSW 注册 Windows 服务

## 项目结构

```text
软件源代码/
├─ zhiqu-backend/              # 主项目，Spring Boot 单体应用
├─ deploy/                     # 部署脚本和配置模板
├─ README.md                   # 项目说明
├─ README-交付版.md
├─ AGENTS.md
└─ CLAUDE.md
```

后端主目录：

```text
zhiqu-backend/
├─ pom.xml
├─ target/                     # Maven 打包产物
├─ logs/                       # 本地运行日志
├─ uploads/                    # 本地上传文件目录
└─ src/main/
   ├─ java/com/zhiqu/
   │  ├─ controller/           # API 控制器
   │  ├─ service/              # 业务接口
   │  ├─ service/impl/         # 业务实现
   │  ├─ entity/               # 数据库实体
   │  ├─ mapper/               # MyBatis-Plus Mapper
   │  ├─ dto/                  # 请求 DTO
   │  ├─ common/               # 统一响应、异常处理
   │  ├─ config/               # 安全、Web、MyBatis、Redis 等配置
   │  ├─ security/             # JWT、限流、IP、鉴权
   │  ├─ scheduler/            # 定时任务
   │  └─ util/                 # 文件解析、上传路径等工具
   └─ resources/
      ├─ application.yml       # 默认开发配置
      ├─ db/migration/         # Flyway 迁移脚本
      └─ static/               # 前端静态页面
```

前端页面：

```text
static/
├─ index.html                  # 落地页 + 登录/注册弹窗
├─ dashboard.html              # 学习看板
├─ ai-assistant.html           # AI 助手
├─ tasks.html                  # 任务管理
├─ routines.html               # 例行计划
├─ shared-plans.html           # 参考计划
├─ shared-plan-admin.html      # 参考计划审核
├─ knowledge-wiki.html         # 知识 Wiki
├─ statistics.html             # 统计
├─ achievement.html            # 成就
├─ profile.html                # 个人中心
├─ admin.html                  # 监管后台
├─ account-admin.html          # 账号管理
├─ feedback-admin.html         # 反馈管理
├─ assets/                     # 当前前端：统一皮肤 / 接口适配层 / 导航
│  ├─ zhiqu-ui.css             #   5 套配色 × 浅/深主题
│  ├─ zhiqu-ui.js              #   侧边导航 + 主题切换
│  ├─ zhiqu-api.js             #   接口适配 + 弹窗 + Markdown/公式渲染 + 各页 boot
│  └─ vendor/katex/            #   本地内置 KaTeX（js/css/字体）
├─ manifest.json
└─ service-worker.js           # PWA 外壳与字体预缓存（版本号即缓存 key）
```

> 说明：`static/css/`、`static/js/`、`static/vendor/` 为改版前的旧前端，已不再被页面引用，保留仅作历史参考。

数据库迁移：

```text
db/migration/
├─ V1__initial_schema.sql
├─ V2__smart_reminders.sql
├─ V3__seed_achievements.sql
├─ V4__ai_memory.sql
├─ V5__study_routines.sql
├─ V6__more_achievements.sql
├─ V7__admin_monitoring_feedback.sql
├─ V8__runtime_issues.sql
├─ V9__concurrency_hardening.sql
├─ V10__product_privacy_models.sql
├─ V11__knowledge_wiki_plan_selection.sql
├─ V12__obsidian_wiki_workspace.sql
├─ V13__shared_plan_ai_wiki_enhancements.sql
├─ V14__ai_model_probe_status.sql
├─ V15__ai_message_research_metadata.sql
├─ V16__ai_message_stream_metadata.sql
├─ V17__ai_message_lifecycle_status.sql
├─ V18__ai_notebook_agent_pipeline.sql
├─ V19__ai_agent_taskgraph_claims_verifier.sql
└─ V20__profile_account_login_history.sql
```

当前数据库结构由 Flyway `V1`–`V20` 按顺序维护。已有数据库启动时会继续执行尚未应用的迁移；新数据库会从 `V1` 完整升级到最新版本。

## 本地开发

### 1. 准备环境

需要安装：

- JDK 17
- Maven 3.8+
- MySQL 8
- Redis

### 2. 创建数据库

```sql
CREATE DATABASE zhiqu_db DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

首次启动时 Flyway 会自动执行 `src/main/resources/db/migration/` 下的迁移脚本，不需要手动执行旧版 `schema.sql` / `data.sql`。

### 3. 修改本地配置

编辑：

```text
zhiqu-backend/src/main/resources/application.yml
```

至少确认：

```yaml
spring:
  datasource:
    url: jdbc:mysql://localhost:3306/zhiqu_db?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai
    username: root
    password: root
  data:
    redis:
      host: 127.0.0.1
      port: 6379
      database: 0
```

本地可以使用默认开发密钥，生产环境必须改掉。

### 4. 启动

```powershell
cd zhiqu-backend
mvn spring-boot:run
```

访问：

```text
http://localhost:8080
```

## 打包

```powershell
cd zhiqu-backend
mvn clean package -DskipTests
```

打包后文件位于：

```text
zhiqu-backend/target/zhiqu-backend-0.0.1-SNAPSHOT.jar
```

运行：

```powershell
java -jar target/zhiqu-backend-0.0.1-SNAPSHOT.jar
```

## 生产部署建议

推荐生产路线：

```text
用户访问 https://你的域名
        ↓
Caddy 监听 80 / 443
        ↓
反向代理到 127.0.0.1:8080
        ↓
Spring Boot JAR
        ↓
MySQL / Redis 只允许本机访问
```

生产环境应使用外部配置文件，例如：

```powershell
java -jar zhiqu-backend-0.0.1-SNAPSHOT.jar --spring.profiles.active=prod
```

或者：

```powershell
java -jar zhiqu-backend-0.0.1-SNAPSHOT.jar --spring.config.location=file:./application-prod.yml
```

生产配置至少需要修改：

- MySQL 用户名和密码
- Redis 地址和密码，如果 Redis 没有密码则不要暴露公网
- `jwt.secret`
- `app.crypto.master-key`
- `app.upload-dir`
- `app.cookie.secure`

正式上线时建议：

```yaml
server:
  address: 127.0.0.1
  port: 8080

app:
  cookie:
    secure: true
```

如果还没有 HTTPS，只是临时通过 IP 访问，可以暂时设置：

```yaml
app:
  cookie:
    secure: false
```

绑定域名并启用 HTTPS 后应改回 `true`。

## 端口安全

公网安全组和 Windows 防火墙只建议开放：

```text
80    HTTP
443   HTTPS
3389  远程桌面，仅允许自己的 IP
```

以下端口不应暴露公网：

```text
3306  MySQL
6379  Redis
8080  Spring Boot
```

可以在本机电脑测试：

```powershell
Test-NetConnection 服务器IP -Port 6379
Test-NetConnection 服务器IP -Port 3306
Test-NetConnection 服务器IP -Port 8080
```

安全状态下这三个都应该是：

```text
TcpTestSucceeded : False
```

## API 说明

所有业务接口以 `/api` 为前缀。

除登录、注册、静态资源外，大部分接口需要登录状态。前端会自动携带会话凭据和 token。

主要接口分组：

```text
/api/auth           登录、注册、当前用户、退出
/api/user           用户资料、头像、密码
/api/task           学习任务
/api/routine        例行计划
/api/dashboard      看板概览
/api/ai             AI 助手、模型配置、文件识别
/api/knowledge      知识 Wiki、Raw Source、Patch Set、图谱、导出
/api/shared-plans   参考计划和模板套用
/api/reminder       提醒设置和测试
/api/achievement    成就
/api/admin          监管后台
/api/feedback       意见反馈
/api/runtime-issue  运行异常上报
```

## 常见问题

### 登录后页面反复跳回登录页

检查：

- 后端是否正常启动。
- Cookie 是否被浏览器拦截。
- 如果没有 HTTPS，`app.cookie.secure` 是否临时设置为 `false`。
- Token 是否过期，可清空浏览器会话后重新登录。

### 启动时报数据库连接失败

检查：

- MySQL 是否启动。
- `zhiqu_db` 是否存在。
- 用户名、密码是否正确。
- 生产环境是否使用了正确的 `application-prod.yml`。

### Redis 连接失败

检查：

- Redis 是否启动。
- 后端配置中的 Redis host/port/password 是否正确。
- Redis 没有密码时，不要在配置里写错误密码。
- Redis 不能暴露公网。

### JAR 打包失败，提示 target 文件被占用

通常是旧的 Java 进程正在运行并锁住了 JAR。

处理方式：

```powershell
Get-Process | Where-Object { $_.ProcessName -like "*java*" }
```

确认是旧后端进程后停止，再重新打包。

### 上传头像或文件失败

检查：

- `app.upload-dir` 是否存在。
- 后端进程是否有写入权限。
- 头像只允许安全图片类型。
- 私密学习资料不要直接放在公开 `/uploads/**` 下，应走鉴权或 Raw Source 流程。

## 部署文档

Windows Server 部署请看：

```text
deploy/windows/README.md
```

备份方案请看：

```text
deploy/windows/BACKUP.md
```
