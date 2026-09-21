# 知趣·象限自主学习系统

> 基于四象限时间管理法的 Web 学习看板，面向大学生学习规划场景。
> 后端提供 REST API，前端以静态文件内嵌于 Spring Boot，开箱即用。

---

## 目录

- [功能概览](#功能概览)
- [技术栈](#技术栈)
- [项目结构](#项目结构)
- [环境要求](#环境要求)
- [部署步骤](#部署步骤)
- [配置说明](#配置说明)
- [API 接口](#api-接口)
- [页面路由](#页面路由)
- [常见问题](#常见问题)

---

## 功能概览

| 模块 | 说明 |
|------|------|
| 用户认证 | 注册、登录、JWT 鉴权、登录状态拦截 |
| 四象限看板 | 任务按重要/紧急维度分类展示，支持在线状态变更 |
| 任务管理 | 新建、编辑、删除、状态更新、截止时间与提醒时间 |
| 番茄钟 | 专注计时、休息提示、自动写入学习记录 |
| 学习统计 | 连续天数、累计时长、趋势图（日/周/月）、象限分布饼图 |
| 成就系统 | 自动/手动检测、积分与等级、解锁时间展示 |
| 个人中心 | 头像上传、昵称编辑、密码修改、个人统计卡 |
| 主题切换 | 现代风 / 像素风，偏好持久化至 localStorage |

---

## 技术栈

**后端**

- Java 17 + Spring Boot 3
- Spring Security + JWT
- MyBatis-Plus + MySQL 8
- Maven

**前端**（内嵌于后端 `static/` 目录，无需单独构建）

- 原生 HTML + CSS + JavaScript
- ECharts 5（统计图表）

---

## 项目结构

```
软件源代码/
├── zhiqu-backend/
│   ├── pom.xml
│   └── src/main/
│       ├── java/com/zhiqu/
│       │   ├── config/          # Security、跨域、静态资源配置
│       │   ├── controller/      # REST 接口层
│       │   ├── service/         # 业务逻辑层
│       │   ├── mapper/          # MyBatis-Plus 数据访问层
│       │   ├── entity/          # 数据库实体
│       │   ├── dto/             # 请求/响应 DTO
│       │   └── security/        # JWT 过滤器与工具类
│       └── resources/
│           ├── application.yml  # 应用配置
│           ├── db/
│           │   ├── migration/   # Flyway 迁移脚本 V1…V26（启动时自动执行）
│           │   ├── schema.sql   # 旧版建表脚本（历史参考，已不再使用）
│           │   └── data.sql     # 旧版初始数据（历史参考，已不再使用）
│           └── static/          # 前端页面
│               ├── index.html   # 登录页
│               ├── dashboard.html
│               ├── tasks.html
│               ├── statistics.html
│               ├── achievement.html
│               ├── profile.html
│               ├── css/
│               └── js/
├── README.md
└── README-交付版.md
```

---

## 环境要求

| 依赖 | 最低版本 |
|------|----------|
| JDK | 17 |
| Maven | 3.8 |
| MySQL | 8.0 |

> 前端无需 Node.js，页面已内嵌于后端，随后端启动一并提供服务。

---

## 部署步骤

### 第一步：初始化数据库

在 MySQL 中创建数据库：

```sql
CREATE DATABASE zhiqu DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

建表与初始数据现在由 **Flyway** 自动完成：后端首次启动时会按顺序执行
`zhiqu-backend/src/main/resources/db/migration/` 下的 `V1` … `V26` 迁移脚本。

因此**不需要**再手动执行旧版的 `schema.sql` / `data.sql`（它们只保留作历史参考，
内容已落后于当前版本，手动执行会得到不完整的表结构）。

你只需要保证数据库已创建：

```sql
CREATE DATABASE zhiqu_db DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

---

### 第二步：修改数据库连接配置

编辑 `zhiqu-backend/src/main/resources/application.yml`，将以下三项改为实际值：

```yaml
spring:
  datasource:
    url: jdbc:mysql://localhost:3306/zhiqu_db?useUnicode=true&characterEncoding=utf8mb4&serverTimezone=Asia/Shanghai
    username: root        # ← 改为实际用户名
    password: yourpasswd  # ← 改为实际密码
```

> 默认库名是 `zhiqu_db`。此外本项目还依赖 **Redis**（限流、幂等、锁），
> 请一并配置 `spring.data.redis.*`。

> 如需修改服务端口，在同文件中设置 `server.port`，默认为 `8080`。

---

### 第三步：启动后端

```bash
cd zhiqu-backend
mvn spring-boot:run
```

> 若仓库路径含中文导致 `mvn spring-boot:run` 报
> `Could not find or load main class com.zhiqu.ZhiquApplication`，
> 改为先打包再运行：`mvn clean package -DskipTests` 然后
> `java -jar target/zhiqu-backend-0.0.1-SNAPSHOT.jar`。

看到以下日志表示启动成功：

```
Started ZhiquApplication in X.XXX seconds
```

---

### 第四步：访问系统

浏览器打开：

```
http://localhost:8080
```

首次使用请先注册账号，注册后即可登录。

---

### 生产环境打包（可选）

如需打包为可独立运行的 JAR 文件，在 `zhiqu-backend` 目录下执行：

```bash
mvn clean package -DskipTests
```

生成文件位于 `target/zhiqu-backend-0.0.1-SNAPSHOT.jar`，运行方式：

```bash
java -jar target/zhiqu-backend-0.0.1-SNAPSHOT.jar
```

如需指定外部配置文件：

```bash
java -jar zhiqu-backend-0.0.1-SNAPSHOT.jar --spring.config.location=./application.yml
```

---

## 配置说明

`application.yml` 关键配置项：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `server.port` | `8080` | HTTP 服务端口 |
| `spring.datasource.url` | — | MySQL 连接串 |
| `spring.datasource.username` | — | 数据库用户名 |
| `spring.datasource.password` | — | 数据库密码 |
| `jwt.secret` | （内置） | JWT 签名密钥，生产环境建议替换为强随机字符串 |
| `jwt.expiration` | `86400000` | Token 有效期，单位毫秒（默认 24 小时） |
| `file.upload-dir` | `uploads/` | 用户头像上传目录，相对于 JAR 所在位置 |

---

## API 接口

所有接口以 `/api` 为前缀。除登录/注册外，其余接口需在请求头携带 Token：

```
Authorization: Bearer <token>
```

### 认证

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/auth/register` | 注册 |
| POST | `/api/auth/login` | 登录，返回 JWT |
| GET | `/api/auth/info` | 获取当前用户信息 |

### 任务

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/task` | 新建任务 |
| GET | `/api/task/list` | 任务列表（支持筛选与排序） |
| GET | `/api/task/quadrant` | 按四象限返回任务 |
| PUT | `/api/task/{id}` | 编辑任务 |
| PUT | `/api/task/{id}/status` | 更新任务状态 |
| DELETE | `/api/task/{id}` | 删除任务 |

### 学习记录与统计

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/record` | 新增学习记录 |
| GET | `/api/record/list` | 学习记录列表 |
| GET | `/api/record/statistics` | 综合统计数据 |
| GET | `/api/record/trend` | 学习趋势（`?type=day/week/month`） |

### 成就

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/achievement/list` | 成就列表（含解锁状态） |
| POST | `/api/achievement/check` | 触发成就检测 |

### 用户

| 方法 | 路径 | 说明 |
|------|------|------|
| PUT | `/api/user/profile` | 更新昵称 |
| PUT | `/api/user/password` | 修改密码 |
| POST | `/api/user/avatar` | 上传头像（multipart/form-data） |

---

## 页面路由

| 路径 | 页面 |
|------|------|
| `/` 或 `/index.html` | 登录 / 注册 |
| `/dashboard.html` | 四象限看板 + 番茄钟 |
| `/tasks.html` | 任务列表与管理 |
| `/statistics.html` | 学习统计与图表 |
| `/achievement.html` | 成就系统 |
| `/profile.html` | 个人中心 |

---

## 常见问题

**Q：页面打开后一直跳回登录页**

- 确认已注册账号并正确输入密码
- 检查 JWT 是否过期（默认 24 小时），清除浏览器 localStorage 后重新登录

**Q：后端启动时报数据库连接错误**

- 确认 MySQL 服务已启动
- 检查 `application.yml` 中的用户名、密码、数据库名是否正确
- 确认数据库 `zhiqu_db` 已创建（建表由 Flyway 在启动时自动完成，无需手动执行 `schema.sql`）
- 若启动日志报 Flyway 校验失败，多为数据库被手工改过；参见 `deploy/windows/README.md` 常见问题

**Q：头像上传后无法显示**

- 检查后端工作目录下是否存在 `uploads/` 文件夹（首次上传会自动创建，需确保有写入权限）
- 检查 `SecurityConfig` 是否放行了 `/uploads/**` 路径

**Q：学习统计页面无数据**

- 需先创建任务并通过番茄钟完成至少一条学习记录，统计数据才会有内容

**Q：成就无法解锁**

- 成就在登录、完成任务、新增学习记录时自动触发检测
- 也可在成就页面点击「检测成就」手动触发

**Q：打包后 JAR 运行正常但头像图片 404**

- JAR 运行时上传目录默认为 JAR 所在目录的 `uploads/` 子目录
- 确认该目录存在且有读写权限，或通过 `--file.upload-dir=/绝对路径/` 指定
