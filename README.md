# 知趣·象限学习系统（Web 重构版）

## 项目简介

本项目为「知趣·象限学习系统」的前后端分离版本，面向大学生学习规划场景，基于四象限时间管理法提供任务管理、学习统计、成就激励和个人中心能力。

当前版本已完成从旧 Electron 架构到 Web 架构的重构，可直接通过浏览器访问。

---

## 技术栈

### 后端（`zhiqu-backend`）
- Java 17
- Spring Boot 3
- Spring Security + JWT
- MyBatis-Plus
- MySQL 8
- Maven

### 前端（内嵌于 `zhiqu-backend`）
- 原生 HTML + CSS + JavaScript
- ECharts（统计图表）

---

## 项目结构

```text
软件源代码/
├── zhiqu-backend/          # Spring Boot 后端（含内嵌前端）
│   ├── src/main/java/com/zhiqu/
│   └── src/main/resources/
│       ├── static/         # 前端 HTML/CSS/JS
│       └── db/             # schema.sql / data.sql
├── README.md
└── README-交付版.md
```

---

## 快速启动

### 1) 初始化数据库

先在 MySQL 中创建数据库（示例）：

```sql
CREATE DATABASE zhiqu DEFAULT CHARACTER SET utf8mb4;
```

然后依次执行：

- `zhiqu-backend/src/main/resources/db/schema.sql`
- `zhiqu-backend/src/main/resources/db/data.sql`

### 2) 配置后端连接

修改 `zhiqu-backend/src/main/resources/application.yml` 中的数据库配置：

- `spring.datasource.url`
- `spring.datasource.username`
- `spring.datasource.password`

### 3) 启动后端

```bash
cd zhiqu-backend
mvn spring-boot:run
```

默认端口：`8080`

### 4) 访问前端

后端启动后，浏览器打开：`http://localhost:8080`

前端页面已内嵌在后端 `src/main/resources/static/` 目录中，无需单独启动。

---

## 已实现功能

- 用户认证：注册、登录、JWT 鉴权、登录状态拦截
- 任务管理：新增/编辑/删除/状态更新、四象限展示、筛选与排序
- 提醒功能：支持提醒时间，页面内到时提醒
- 学习统计：连续学习天数、总学习时长、任务完成情况、趋势图、象限分布图
- 成就系统：自动/手动检测、解锁状态、积分与等级、解锁时间展示
- 个人中心：头像上传、昵称编辑、密码修改、个人统计卡
- 主题切换：现代风 / 像素风

---

## 主要接口（摘要）

### 认证
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/info`

### 任务
- `POST /api/task`
- `PUT /api/task/{id}`
- `DELETE /api/task/{id}`
- `GET /api/task/list`
- `PUT /api/task/{id}/status`

### 学习记录与统计
- `POST /api/record`
- `GET /api/record/list`
- `GET /api/record/statistics`
- `GET /api/record/trend`

### 成就
- `GET /api/achievement/list`
- `POST /api/achievement/check`

### 用户
- `PUT /api/user/profile`
- `PUT /api/user/password`
- `POST /api/user/avatar`

---

## 前端页面

- `/login` 登录/注册
- `/` 四象限看板
- `/tasks` 任务管理
- `/statistics` 学习统计
- `/achievement` 成就系统
- `/profile` 个人中心

---

## 常见问题

- 前端无法访问后端：确认后端服务是否启动在 `8080`
- 登录后跳回登录页：检查 Token 是否过期或后端返回 401
- 头像无法显示：确认后端 `uploads/` 目录权限与 `/uploads/**` 映射
- 无统计数据：需先创建任务并新增学习记录

---

## 说明

- 前端页面内嵌于后端 `src/main/resources/static/` 目录，无需单独构建
- 更详细交付文档请查看：`README-交付版.md`