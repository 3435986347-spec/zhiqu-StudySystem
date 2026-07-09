# 部署目录说明

`deploy` 目录保存知趣·象限学习系统的生产部署脚本、配置模板和运维说明。

当前默认部署目标是：

```text
Windows Server + Spring Boot JAR + MySQL 8 + Redis + Caddy + WinSW
```

## 目录结构

```text
deploy/
└─ windows/
   ├─ README.md                         # Windows Server 部署说明
   ├─ BACKUP.md                         # 备份与恢复说明
   ├─ application-prod.example.yml      # 生产配置模板
   ├─ create-database.sql               # 创建数据库和应用账号
   ├─ Caddyfile.example                 # Caddy 反向代理模板
   ├─ zhiqu-backend.xml                 # WinSW 后端服务配置
   ├─ caddy-service.xml                 # WinSW Caddy 服务配置
   ├─ install-zhiqu-service.ps1         # 安装后端 Windows 服务
   ├─ uninstall-zhiqu-service.ps1       # 卸载后端 Windows 服务
   ├─ install-caddy-service.ps1         # 安装 Caddy Windows 服务
   ├─ uninstall-caddy-service.ps1       # 卸载 Caddy Windows 服务
   ├─ backup-zhiqu.ps1                  # 备份脚本
   └─ install-zhiqu-backup-task.ps1     # 安装定时备份任务
```

## 推荐阅读顺序

1. 先阅读 Windows 部署文档：

```text
deploy/windows/README.md
```

2. 部署成功后阅读备份文档：

```text
deploy/windows/BACKUP.md
```

3. 根据服务器实际情况修改：

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
```

生产配置中的密钥必须换成强随机字符串：

```text
jwt.secret
app.crypto.master-key
spring.datasource.password
spring.data.redis.password
```

如果 Redis 没有密码，必须确保它只监听 `127.0.0.1`，并且云安全组和 Windows 防火墙都关闭公网 `6379`。
