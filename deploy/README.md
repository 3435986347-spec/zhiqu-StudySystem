# 部署目录说明

`deploy` 目录保存知趣·象限学习系统的生产部署脚本、配置模板和运维说明。

当前默认部署目标是：

```text
Windows Server + Spring Boot JAR + MySQL 8 + Redis + Caddy + WinSW
```

语义检索（RAG）为**可选**组件：额外多一个本地 Python sidecar（`rag-service`，监听 `127.0.0.1:8001`）。
不安装时系统自动回退到关键词检索，其余功能不受影响。

## 目录结构

```text
deploy/
└─ windows/
   ├─ README.md                         # Windows Server 部署说明
   ├─ BACKUP.md                         # 备份与恢复说明
   ├─ RUNBOOK-e4-rag-cutover.md         # 首次启用语义检索（E-4）的操作顺序
   ├─ application-prod.example.yml      # 生产配置模板
   ├─ create-database.sql               # 创建数据库和应用账号
   ├─ Caddyfile.example                 # Caddy 反向代理模板
   ├─ zhiqu-backend.xml                 # WinSW 后端服务配置
   ├─ caddy-service.xml                 # WinSW Caddy 服务配置
   ├─ install-zhiqu-service.ps1         # 安装后端 Windows 服务
   ├─ uninstall-zhiqu-service.ps1       # 卸载后端 Windows 服务
   ├─ install-caddy-service.ps1         # 安装 Caddy Windows 服务
   ├─ uninstall-caddy-service.ps1       # 卸载 Caddy Windows 服务
   ├─ zhiqu-rag.xml                     # WinSW RAG sidecar 服务配置（可选）
   ├─ install-rag-service.ps1           # 安装 RAG sidecar Windows 服务（可选）
   ├─ uninstall-rag-service.ps1         # 卸载 RAG sidecar Windows 服务（可选）
   ├─ backup-zhiqu.ps1                  # 备份脚本
   └─ install-zhiqu-backup-task.ps1     # 安装定时备份任务
```

RAG sidecar 的源码与依赖不在本目录，位于仓库根部的 `rag-service/`（安装步骤见
`deploy/windows/README.md` 第六节）。

## 关于部署 JAR

**仓库里不保存构建产物**，本目录不含 `zhiqu-backend-0.0.1-SNAPSHOT.jar`。部署时按
`deploy/windows/README.md` 第三节在本地打包，再把产物上传到服务器：

```powershell
cd zhiqu-backend
mvn clean package -DskipTests
# 产物：zhiqu-backend\target\zhiqu-backend-0.0.1-SNAPSHOT.jar
```

这样做的原因：JAR 约 75MB，超过 GitHub 单文件 50MB 的建议上限，每更新一次就会在
Git 历史里多压一份；而且仓库里存一份旧 JAR 很容易被误当成最新版直接上线。

## 推荐阅读顺序

1. 先阅读 Windows 部署文档：

```text
deploy/windows/README.md
```

2. 部署成功后阅读备份文档：

```text
deploy/windows/BACKUP.md
```

3. 只有在要**首次启用语义检索**时才读这一份（把 `app.rag.enabled` 翻成 true 的那一次操作，
   顺序是被机制强制的，不要凭印象操作）：

```text
deploy/windows/RUNBOOK-e4-rag-cutover.md
```

4. 根据服务器实际情况修改：

```text
deploy/windows/application-prod.example.yml
deploy/windows/create-database.sql
deploy/windows/Caddyfile.example
```

## 关键安全原则

公网只开放：

```text
80
443
```

如果需要远程桌面，`3389` 只能允许自己的公网 IP。

以下端口不能暴露公网：

```text
3306  MySQL
6379  Redis
8080  Spring Boot
8001  Python RAG Sidecar（启用语义检索时）
```

生产配置中的密钥必须换成强随机字符串：

```text
jwt.secret
app.crypto.master-key
spring.datasource.password
spring.data.redis.password
app.rag.service-token        启用 RAG 时，后端与 sidecar 必须填同一个随机串
```

以下 Key 不要写进配置文件，用环境变量注入（服务配置或系统环境变量）：

```text
ZHIQU_SYSTEM_AI_API_KEY      系统级默认模型的 API Key
ZHIQU_WEB_SEARCH_API_KEY     联网搜索的 API Key
ZHIQU_WEB_PUSH_PUBLIC_KEY    Web Push VAPID 公钥
```

注意：`app.crypto.master-key` 一旦更换，**历史加密数据（AI Key、知识页正文等）将无法解密**，
更换前必须先备份并做好迁移方案。

如果 Redis 没有密码，必须确保它只监听 `127.0.0.1`，并且云安全组和 Windows 防火墙都关闭公网 `6379`。
