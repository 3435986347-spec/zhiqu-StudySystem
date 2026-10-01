# 桌面应用连远程数据库

目标：在任何一台机器上装同一个应用、登录同一个账号，看到同一份数据，
**同时** coding agent 仍然能读这台机器上的代码。

## 为什么不能直接开放 3306

最直接的做法是把服务器的 MySQL 端口开到公网，桌面端直连。**不要这么做。**
公网上的 3306 会被持续扫描和暴力破解，而数据库里是你全部的学习数据、
加密过的 AI 密钥和 Wiki 正文。

下面两种办法都能让桌面端连上，而端口始终不对公网开放。

## 办法一：Tailscale（推荐，跨平台最省事）

在服务器和你每台电脑上都装 Tailscale，登录同一个账号。它会给每台机器一个
私有地址（`100.x.x.x`），只有你自己的设备之间能互通，不经过公网。

服务器上 MySQL 保持 `bind-address = 127.0.0.1` 的话，Tailscale 也连不上；
改成监听 Tailscale 那块网卡即可：

```ini
# my.ini
bind-address = 127.0.0.1,100.x.x.x
```

然后桌面端 `~/.zhiqu/application.yml`：

```yaml
spring:
  datasource:
    url: jdbc:mysql://100.x.x.x:3306/zhiqu_db?useUnicode=true&characterEncoding=utf-8&serverTimezone=Asia/Shanghai&useSSL=false&allowPublicKeyRetrieval=true
    username: zhiqu_app
    password: 你的密码
```

换一台电脑，装 Tailscale + 这个应用 + 同一份配置，就是同一份数据。

## 办法二：SSH 隧道

Windows Server 2019 及以上可以装 OpenSSH Server（可选功能）。装好之后，
在**你的电脑**上开隧道：

```bash
ssh -N -L 13306:127.0.0.1:3306 你的用户@134.175.110.207
```

这条命令把本机的 13306 映射到服务器内部的 3306，全程走 SSH 加密，
服务器的 3306 依然不对公网开放。配置里连本机：

```yaml
spring:
  datasource:
    url: jdbc:mysql://127.0.0.1:13306/zhiqu_db?useUnicode=true&characterEncoding=utf-8&serverTimezone=Asia/Shanghai&useSSL=false&allowPublicKeyRetrieval=true
```

缺点是每次用之前要先开隧道。可以做成开机自启（macOS 用 launchd，Windows 用计划任务）。

## 两种形态怎么配合

| | 走什么 | coding agent |
|---|---|---|
| **网页**（手机、别人的电脑） | `https://你的域名.com` | ✗ |
| **桌面应用**（你自己的电脑） | 本机后端 + 远程 MySQL | ✓ |

两边读写的是**同一个库**，所以在网页上加的任务，桌面应用里立刻能看到，反之亦然。

## 一个必须知道的限制

桌面端和服务器上的应用**同时在跑**，两份都会连同一个库。这没问题 ——
数据都按 `userId` 隔离，写操作有乐观锁。但有两处要留意：

- **Flyway 迁移**：两份应用启动时都会尝试跑迁移。Flyway 有锁，不会互相破坏，
  但升级时最好先停一边、升完再起另一边，避免版本不一致。
- **限流**：两份各自连 Redis，计数是共享的；Redis 挂掉时各自降级到进程内计数，
  那时限流就是各算各的。

## 不要做的事

- 不要把 3306 或 6379 加进云安全组
- 不要为了图方便把 MySQL 的 `bind-address` 改成 `0.0.0.0`
- 不要在两台机器上用不同的 `app.crypto.master-key` —— 换了主密钥，
  已存的 AI 密钥、Wiki 正文和推送凭据就全解不开了（两边必须一致）
