# 轮换泄漏的密钥

2026-07-09 的一次提交把服务器那份真实的 `application-prod.yml` 原样贴进了
`deploy/windows/README.md` 当示例，其中三个真值（数据库口令、`jwt.secret`、
`app.crypto.master-key`）随之进入**公开**仓库，2026-09-22 才发现并清除。另外一个 Tavily
API key 在一次对话里以明文贴出。

**清掉文件只是止血 —— 这些值在 git 历史里，且可能已被抓取，必须全部轮换。**
下面按紧急度排序。`NoCommittedSecretsTest` 现在会拦住「真密钥再次进仓库」。

---

## 1. `jwt.secret`（最紧急）

泄漏后果最重：拿到它的人能**伪造任意用户的登录令牌**，不需要密码。

`JwtUtils` 用 `Keys.hmacShaKeyFor(secret)` 签发和校验。换掉之后，**所有现有令牌签名校验
失败**，全体用户需要重新登录一次 —— 这是唯一的副作用，没有数据损失、不需要迁移。

1. 生成新值（至少 32 字符随机串，别经过聊天 / 工单）：
   ```bash
   openssl rand -base64 48 | tr -d '\n/+=' | head -c 64
   ```
2. 改服务器上 `application-prod.yml` 的 `jwt.secret`。
3. 重启后端。所有人重新登录一次即可。

> `StartupSecretGuard` 会拒绝空的 / 占位符的 / 仓库开发默认值的 `jwt.secret`，
> 所以填错会在启动期就炸，而不是默默用一个弱值。

---

## 2. 数据库口令（`zhiqu_app`）

紧急程度取决于 3306 有没有对公网开（见下面「顺带检查」）。

1. 在 MySQL 里改口令：
   ```sql
   ALTER USER 'zhiqu_app'@'localhost' IDENTIFIED BY '<新口令>';
   -- 若应用从别的主机连，把 'localhost' 换成实际来源主机或 '%'
   FLUSH PRIVILEGES;
   ```
2. 改 `application-prod.yml` 的 `spring.datasource.password`。
3. 重启后端。

---

## 3. Tavily API key

只会被人刷额度，不碰你的数据。

1. 在 Tavily 后台（https://app.tavily.com）**吊销旧 key、签发新 key**。
2. 新 key 通过环境变量注入，**不写进配置文件**：
   - Windows 服务：在 `zhiqu-backend.xml` 的 `<env>` 里设 `ZHIQU_WEB_SEARCH_API_KEY`，
     或在系统环境变量里设，然后重启服务。
   - 本地：`export ZHIQU_WEB_SEARCH_API_KEY=<新 key>`。

---

## 4. `app.crypto.master-key`

它是敏感字段的加密根，**不能直接改** —— 改了现有密文全部解不开。有专门的轮换工具，
见 **[rotate-crypto-key.md](rotate-crypto-key.md)**（旧 key 解、新 key 重加密，可重入、
解不开就硬停）。

> 如果 master-key 泄漏了但你评估「密文即使被解开也无所谓」，也可以先不轮换它 ——
> 但那意味着任何拿到旧 master-key + 一份数据库备份的人，能解开所有 AI 密钥和 Wiki 正文。

---

## 顺带检查：Redis / MySQL 有没有对公网开

比换密钥更优先。无密码且监听公网的 Redis 通常几小时内就会被扫到并接管。在服务器上：

```powershell
netstat -ano | findstr ":6379 :3306"
```

看到 `0.0.0.0:6379` / `0.0.0.0:3306`（而不是 `127.0.0.1:...`）就要立刻处理：让它们只监听
内网，桌面端 / 远程访问走 SSH 隧道或 WireGuard（见 desktop/remote-database.md）。
Redis 也要设 `requirepass`，模板里 `spring.data.redis.password` 那行对应它。

---

## 做完之后

- 确认服务能正常登录、AI 检索能用（验证 jwt / tavily 换对了）。
- 若担心历史泄漏被利用，检查一下有没有异常登录 / 异常查询。
- git 历史里的旧值已经无法「撤销」，但轮换后它们就失效了 —— 这才是真正的修复。
