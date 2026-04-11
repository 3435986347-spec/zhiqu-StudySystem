# 知趣·象限学习系统（交付版说明）

## 1. 项目简介

本项目已从 Electron 单机结构重构为前后端分离 Web 架构：

- 后端：`zhiqu-backend`（Spring Boot 3 + MyBatis-Plus + MySQL + Spring Security + JWT）
- 前端：`zhiqu-frontend`（Vue 3 + TypeScript + Vite + Pinia + Axios + Element Plus + ECharts）

核心功能包括：认证、任务管理、四象限看板、学习统计、成就系统、提醒功能、个人中心。

---

## 2. 环境要求

- JDK 17+
- Maven 3.8+
- Node.js 18+
- MySQL 8.x

---

## 3. 一键启动流程

### 3.1 初始化数据库

1. 在 MySQL 创建数据库（示例）：

```sql
CREATE DATABASE zhiqu DEFAULT CHARACTER SET utf8mb4;
```

2. 依次执行脚本：

- `zhiqu-backend/src/main/resources/db/schema.sql`
- `zhiqu-backend/src/main/resources/db/data.sql`

### 3.2 配置后端数据库连接

编辑 `zhiqu-backend/src/main/resources/application.yml`：

- `spring.datasource.url`
- `spring.datasource.username`
- `spring.datasource.password`

### 3.3 启动后端

```bash
cd zhiqu-backend
mvn spring-boot:run
```

默认地址：`http://localhost:8080`

### 3.4 启动前端

```bash
cd zhiqu-frontend
npm install
npm run dev
```

默认地址：`http://localhost:5173`

---

## 4. 功能验收清单

### 4.1 用户认证

- [ ] 注册（用户名/密码/确认密码）
- [ ] 登录后获取 JWT
- [ ] 未登录访问受保护路由自动跳转登录
- [ ] Token 过期返回 401 后自动跳转登录
- [ ] 登出清除登录态

### 4.2 任务管理

- [ ] 新建任务（含象限、优先级、状态、截止时间、提醒时间）
- [ ] 编辑任务
- [ ] 删除任务
- [ ] 更新任务状态
- [ ] 按象限展示（Dashboard 2x2）
- [ ] 列表页筛选（象限/状态/优先级）与排序（更新时间/截止时间/优先级）

### 4.3 学习统计

- [ ] 连续学习天数
- [ ] 累计学习时长
- [ ] 已完成任务数/总任务数
- [ ] 学习趋势（日/周/月）
- [ ] 各象限任务分布图

### 4.4 成就系统

- [ ] 成就列表（已解锁/未解锁）
- [ ] 手动检测成就
- [ ] 自动触发成就（登录/完成任务/新增学习记录）
- [ ] 显示总积分与等级
- [ ] 显示解锁时间

### 4.5 提醒功能

- [ ] 设置提醒时间 `reminderTime`
- [ ] Dashboard 页面触发提醒通知（到提醒时间/默认截止前30分钟）

### 4.6 个人中心

- [ ] 头像上传与展示
- [ ] 昵称编辑
- [ ] 修改密码
- [ ] 个人统计卡（成就点/连续学习天数/累计学习分钟）

---

## 5. API 对照（当前实现）

### 5.1 认证

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/info`

### 5.2 任务

- `POST /api/task`
- `PUT /api/task/{id}`
- `DELETE /api/task/{id}`
- `GET /api/task/{id}`
- `GET /api/task/list`
- `GET /api/task/quadrant`
- `PUT /api/task/{id}/status`

### 5.3 学习记录与统计

- `POST /api/record`
- `GET /api/record/list`
- `GET /api/record/statistics`
- `GET /api/record/trend`

### 5.4 成就

- `GET /api/achievement/list`
- `POST /api/achievement/check`

### 5.5 用户

- `PUT /api/user/profile`
- `PUT /api/user/password`
- `POST /api/user/avatar`

---

## 6. 前端页面路由

- `/login` 登录/注册
- `/` Dashboard 四象限看板
- `/tasks` 任务列表与管理
- `/statistics` 学习统计
- `/achievement` 成就页面
- `/profile` 个人中心

---

## 7. 主题与界面

- 默认现代风格
- 支持像素风主题切换（顶部导航按钮）
- 主题偏好存储于本地 `localStorage`

---

## 8. 常见问题排查

1. 前端请求失败：
   - 检查后端是否启动在 `8080`
   - 检查 Vite 代理配置是否保留

2. 登录失败：
   - 检查数据库中是否有该用户
   - 检查密码是否被修改

3. 头像无法访问：
   - 检查后端 `uploads/` 目录是否创建
   - 检查后端静态资源映射与 `SecurityConfig` 是否放行 `/uploads/**`

4. 成就不解锁：
   - 检查是否触发对应条件（登录、完成任务、累计学习时长等）
   - 手动调用成就检测按钮验证

---

## 9. 答辩建议（可直接使用）

- 先展示架构升级：Electron 单机 -> 前后端分离 Web
- 再演示核心路径：注册登录 -> 建任务 -> 四象限 -> 统计图 -> 成就解锁 -> 个人中心
- 最后强调技术点：
  - JWT 鉴权 + 路由守卫
  - MyBatis-Plus 逻辑删除与自动填充
  - ECharts 趋势/分布可视化
  - 可选像素主题与提醒机制

---

如需提交前打包说明，可再补一份「部署版 README」用于服务器环境（Nginx + Jar + MySQL）。
