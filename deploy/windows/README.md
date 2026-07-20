# Windows Server 部署说明

本文档用于把“知趣·象限学习系统”部署到 Windows Server。推荐部署方式是：

```text
Windows Server
├─ Spring Boot 可执行 JAR
├─ MySQL 8
├─ Redis / Memurai
├─ Caddy 反向代理 HTTPS
└─ WinSW 注册 Windows 服务
```

前端静态页面已经内嵌在 Spring Boot JAR 中，因此服务器上不需要单独安装 Node.js，也不需要单独部署前端。

## 一、部署目标结构

推荐服务器目录：

```text
C:\zhiqu\
├─ zhiqu-backend-0.0.1-SNAPSHOT.jar
├─ application-prod.yml
├─ zhiqu-backend.xml
├─ zhiqu-backend.exe
├─ zhiqu-rag.xml
├─ zhiqu-rag.exe
├─ rag-service\
├─ models\bge-small-zh-v1.5\
├─ rag-data\
├─ create-database.sql
├─ uploads\
├─ logs\
└─ scripts\

C:\caddy\
├─ caddy.exe
├─ caddy-service.exe
├─ caddy-service.xml
└─ Caddyfile
```

如果你的服务器只有 C 盘，使用 `C:\zhiqu` 和 `C:\caddy` 即可。

## 二、服务器需要安装的软件

### 1. JDK 17

安装 JDK 17，并确认：

```powershell
java -version
```

应能看到 Java 17。

### 2. MySQL 8

安装 MySQL 8，建议只允许本机访问。

生产环境不要把 `3306` 暴露公网。

### 3. Redis

Windows 上可以使用：

- Memurai
- Redis Windows 兼容版本
- 云厂商托管 Redis

如果 Redis 没有密码，必须确保它只监听本机，且公网不能访问 `6379`。

Redis 建议配置：

```conf
bind 127.0.0.1
protected-mode yes
```

### 4. Caddy

Caddy 用来监听公网 `80/443`，自动申请 HTTPS 证书，并转发到本机后端：

```text
https://你的域名 → Caddy → http://127.0.0.1:8080
```

### 5. WinSW

WinSW 用来把后端 JAR 和 Caddy 注册成 Windows 服务，实现后台运行和开机自启。

下载 WinSW x64 后分别放到：

```text
C:\zhiqu\zhiqu-backend.exe
C:\caddy\caddy-service.exe
```

注意：WinSW 的 exe 文件名要和 XML 文件名对应。

### 6. Python RAG Sidecar（可选）

语义检索默认关闭，未安装 sidecar 时系统继续使用原有关键词检索。启用前准备 Python 3.11，并把 `rag-service` 整体复制到：

```text
C:\zhiqu\rag-service
```

在可联网的部署准备环境创建虚拟环境并安装锁定依赖：

```powershell
cd C:\zhiqu\rag-service
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.lock
```

模型必须提前下载并固定 revision，完整目录复制到：

```text
C:\zhiqu\models\bge-small-zh-v1.5
```

生产机首次启动不会联网下载模型。复制 `.env.example` 为 `.env`，填写与 `application-prod.yml` 相同的随机 `service token` 和真实模型 revision。再把 WinSW x64 复制为 `C:\zhiqu\zhiqu-rag.exe`，并执行：

```powershell
cd C:\zhiqu
.\install-rag-service.ps1
```

使用 `Authorization: Bearer <service token>` 请求 `http://127.0.0.1:8001/health/live` 确认可访问后，将 `application-prod.yml` 的 `app.rag.enabled` 改为 `true`，重启后端，在监管后台创建第一代索引；代次构建完成后再手动启用。sidecar 只监听回环地址，不要开放公网 `8001`。

当前 Sidecar 一次只服务一个模型/index version。同版本索引可在监管后台蓝绿重建和回滚；升级模型时应先保持 Feature Flag 关闭或接受关键词降级窗口，部署匹配新版本的 Sidecar 后再重建并启用，不能把它表述为跨模型版本无缝切换。

## 三、本地打包 JAR

在本机项目根目录执行：

```powershell
cd zhiqu-backend
mvn clean package -DskipTests
```

生成文件：

```text
zhiqu-backend\target\zhiqu-backend-0.0.1-SNAPSHOT.jar
```

把这个 JAR 复制到服务器：

```text
C:\zhiqu\zhiqu-backend-0.0.1-SNAPSHOT.jar
```

如果打包时提示 JAR 被占用，通常是本机已有旧 Java 进程正在运行。先停止旧进程，再重新打包。

## 四、复制部署文件

把以下文件复制到服务器 `C:\zhiqu`：

```text
deploy\windows\application-prod.example.yml
deploy\windows\zhiqu-backend.xml
deploy\windows\install-zhiqu-service.ps1
deploy\windows\uninstall-zhiqu-service.ps1
deploy\windows\create-database.sql
deploy\windows\backup-zhiqu.ps1
deploy\windows\install-zhiqu-backup-task.ps1
```

把：

```text
application-prod.example.yml
```

重命名为：

```text
application-prod.yml
```

把以下文件复制到 `C:\caddy`：

```text
deploy\windows\Caddyfile.example
deploy\windows\caddy-service.xml
deploy\windows\install-caddy-service.ps1
deploy\windows\uninstall-caddy-service.ps1
```

把：

```text
Caddyfile.example
```

重命名为：

```text
Caddyfile
```

## 五、创建数据库和用户

编辑：

```text
C:\zhiqu\create-database.sql
```

把数据库密码改成强密码。

然后在服务器管理员 PowerShell 中执行：

```powershell
cd C:\zhiqu
cmd /c "mysql -u root -p --default-character-set=utf8mb4 < create-database.sql"
```

说明：

- 只需要创建空库和应用用户。
- 不要手动执行 `schema.sql` 或 `data.sql`。
- 启动后端时 Flyway 会自动执行 `db/migration` 里的迁移脚本。

## 六、配置生产环境

编辑：

```text
C:\zhiqu\application-prod.yml
```

推荐配置示例：

```yaml
server:
  address: 127.0.0.1
  port: 8080
  forward-headers-strategy: native

spring:
  datasource:
    url: jdbc:mysql://127.0.0.1:3306/zhiqu_db?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai&useSSL=false&allowPublicKeyRetrieval=true
    username: zhiqu_app
    password: HUANGMINGZHANG@ZHIQUMYSQL
    driver-class-name: com.mysql.cj.jdbc.Driver

  data:
    redis:
      host: 127.0.0.1
      port: 6379
      database: 0
      timeout: 3000ms

jwt:
  secret: hzFsqFhYbcGcLZHL5iFXpp6a5cB4jwvHKS6g492E
  expiration: 86400000
  remember-expiration: 2592000000

app:
  upload-dir: C:/zhiqu/uploads
  cookie:
    secure: false
  crypto:
    master-key: hzFsqFhYbcGcLZHL5iFXpp6a5cB4jwvHKS6g492E

logging:
  file:
    name: C:/zhiqu/logs/zhiqu-backend.log
```

如果 Redis 设置了密码，再增加：

```yaml
spring:
  data:
    redis:
      password: 你的Redis密码
```

如果 Redis 没有密码，就不要写 `password`，或者保持为空。

### 临时使用 IP 访问时

如果还没有域名和 HTTPS，只是临时通过：

```text
http://服务器IP
```

或：

```text
http://服务器IP:8080
```

访问，可以临时设置：

```yaml
app:
  cookie:
    secure: false
```

正式绑定域名并启用 HTTPS 后，必须改回：

```yaml
secure: true
```

## 七、配置 Caddy

编辑：

```text
C:\caddy\Caddyfile
```

如果已经有域名：

```caddyfile
your-domain.com {
    reverse_proxy 127.0.0.1:8080
}
```

把 `your-domain.com` 改成你的域名。

如果暂时没有域名，只想测试 IP 访问，可以先使用：

```caddyfile
:80 {
    reverse_proxy 127.0.0.1:8080
}
```

但正式产品上线建议使用域名和 HTTPS。

## 八、防火墙和安全组

公网只建议开放：

```text
80    HTTP
443   HTTPS
3389  远程桌面，仅允许自己的公网 IP
```

以下端口必须关闭公网访问：

```text
3306  MySQL
6379  Redis
8080  Spring Boot
```

### 云服务器安全组

在云厂商控制台关闭入站规则：

```text
3306
6379
8080
```

只保留：

```text
80
443
```

如果需要远程桌面，`3389` 不要对 `0.0.0.0/0` 开放，只允许你自己的公网 IP。

### Windows 防火墙

管理员 PowerShell 执行：

```powershell
New-NetFirewallRule -DisplayName "Block Redis Public 6379" -Direction Inbound -Action Block -Protocol TCP -LocalPort 6379
New-NetFirewallRule -DisplayName "Block MySQL Public 3306" -Direction Inbound -Action Block -Protocol TCP -LocalPort 3306
New-NetFirewallRule -DisplayName "Block Spring Boot Public 8080" -Direction Inbound -Action Block -Protocol TCP -LocalPort 8080
```

### 从本机电脑验证

在你自己的电脑上执行：

```powershell
Test-NetConnection 服务器IP -Port 6379
Test-NetConnection 服务器IP -Port 3306
Test-NetConnection 服务器IP -Port 8080
```

安全状态下都应该是：

```text
TcpTestSucceeded : False
```

检查 Caddy 端口：

```powershell
Test-NetConnection 服务器IP -Port 80
Test-NetConnection 服务器IP -Port 443
```

配置完成后，`80/443` 应该可访问。

## 九、启动前测试后端

先不要安装服务，手动启动一次：

```powershell
cd C:\zhiqu
java -jar .\zhiqu-backend-0.0.1-SNAPSHOT.jar --spring.config.location=file:./application-prod.yml
```

看到：

```text
Started ZhiquApplication
```

说明启动成功。

本机测试：

```text
http://127.0.0.1:8080
```

测试完成后按 `Ctrl+C` 停止。

## 十、安装 Windows 服务

管理员 PowerShell 执行：

```powershell
cd C:\zhiqu
.\install-zhiqu-service.ps1
```

安装 Caddy 服务：

```powershell
cd C:\caddy
.\install-caddy-service.ps1
```

查看服务状态：

```powershell
Get-Service zhiqu-backend
Get-Service caddy
```

启动服务：

```powershell
Start-Service zhiqu-backend
Start-Service caddy
```

重启服务：

```powershell
Restart-Service zhiqu-backend
Restart-Service caddy
```

停止服务：

```powershell
Stop-Service zhiqu-backend
Stop-Service caddy
```

## 十一、DNS 配置

在域名解析里添加 A 记录：

```text
主机记录：app 或 @
记录类型：A
记录值：服务器公网 IP
```

例如：

```text
app.zhiqustudy.com → 服务器公网 IP
```

DNS 生效后，Caddy 会自动申请 HTTPS 证书。

## 十二、上线验证

按顺序检查：

1. 浏览器访问 `https://你的域名` 能打开登录页。
2. 可以注册、登录。
3. 可以创建任务。
4. 可以创建例行计划。
5. AI 助手可以正常对话。
6. 知识 Wiki 可以打开。
7. 头像上传后可以显示。
8. PushPlus 测试提醒可以发出。
9. 监管后台只有管理员能访问。
10. MySQL 里存在 `flyway_schema_history` 表。

## 十三、升级版本

本地重新打包：

```powershell
cd zhiqu-backend
mvn clean package -DskipTests
```

上传新 JAR 覆盖：

```text
C:\zhiqu\zhiqu-backend-0.0.1-SNAPSHOT.jar
```

重启服务：

```powershell
Restart-Service zhiqu-backend
```

如果新增了 Flyway 迁移脚本，后端启动时会自动执行。

## 十四、备份

建议启用自动备份，尤其是只有系统盘的服务器。

备份文档：

```text
deploy/windows/BACKUP.md
```

至少需要备份：

```text
MySQL 数据库 zhiqu_db
C:\zhiqu\uploads
C:\zhiqu\application-prod.yml
```

本地磁盘备份只能防误删，不能防服务器损坏。真正可靠的灾备需要上传到另一台服务器、对象存储或网盘。

## 十五、常见问题

### 1. Redis 没设置密码怎么办？

可以不写 `spring.data.redis.password`。

但必须保证：

- Redis 只监听 `127.0.0.1`。
- 公网 `6379` 不可访问。
- 云安全组和 Windows 防火墙都关闭 `6379`。

### 2. MySQL 为什么不能开放公网？

MySQL 开公网会暴露暴力破解、弱口令、漏洞扫描风险。

后端和 MySQL 在同一台服务器时，MySQL 只需要监听本机：

```ini
bind-address=127.0.0.1
```

### 3. 为什么 Spring Boot 要绑定 `127.0.0.1`？

因为公网只应该访问 Caddy 的 `80/443`。后端 `8080` 只给 Caddy 转发，不直接暴露给外网。

### 4. 访问 HTTPS 失败

检查：

- 域名 A 记录是否指向服务器公网 IP。
- 云安全组是否开放 `80/443`。
- Windows 防火墙是否开放 `80/443`。
- Caddy 服务是否启动。
- Caddyfile 域名是否写对。

### 5. 启动时报 Flyway 错误

检查：

- 数据库是否为空库。
- 是否手动执行过旧版 SQL 导致表结构不一致。
- `flyway_schema_history` 是否存在异常记录。

如果是本地旧库升级，需要单独评估迁移状态，不建议直接删除生产数据表。

### 6. JAR 被占用无法覆盖

先停止服务：

```powershell
Stop-Service zhiqu-backend
```

再覆盖 JAR。

覆盖完成后：

```powershell
Start-Service zhiqu-backend
```
