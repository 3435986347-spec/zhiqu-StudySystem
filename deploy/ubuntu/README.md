# Ubuntu 上部署（第一百一十九轮）

现在线上用的是这一份：Ubuntu 26.04（2 核 2G）+ Spring Boot JAR + MySQL + Redis + Caddy + systemd，地址 `https://zhiqustudy.com`。
Windows 那份（`deploy/windows/`）是之前的。

## 东西放在哪

```text
/home/ubuntu/zhiqu-StudySystem/
├─ app/zhiqu-backend.jar                 # 后端
├─ config/application-prod.yml           # 配置和密钥（root:zhiqu 640）。主密钥在这里，丢了库里的密文就解不开
├─ data/uploads, downloads, workspace-state
├─ data/artifact-spaces/                 # 生成到产物的临时空间：单独一块 4G 的小文件系统，写满了也只满这一块
├─ logs/
├─ backups/                              # 每晚一份（root 700），留 7 天。和数据在同一台机器上，要真的安全得再同步到别处
└─ deploy/                               # 脚本、命令行源码（跑隔离判据用）
```

后端跑在专门的 `zhiqu` 账号下，**不是 `ubuntu`**：`ubuntu` 有免密 sudo，而所有注册用户都能叫起命令的进程不能跑在它下面。

## 第一次

本机（开发机）上，先把脚本传过去，在服务器上装好依赖和配置：

```bash
ssh -i ~/.ssh/zhiqu_server ubuntu@134.175.110.207 'mkdir -p ~/zhiqu-StudySystem/incoming'
```

```bash
scp -i ~/.ssh/zhiqu_server -r deploy/ubuntu ubuntu@134.175.110.207:zhiqu-StudySystem/incoming/deploy-ubuntu
```

```bash
ssh -i ~/.ssh/zhiqu_server ubuntu@134.175.110.207 'sudo bash ~/zhiqu-StudySystem/incoming/deploy-ubuntu/install.sh'
```

密钥在服务器上现生成，不打印、不进仓库。再跑一遍 `install.sh` 也没事：配置文件存在就不动（主密钥一换，库里的密文就解不开了）。

然后传 JAR、起服务：

```bash
ZHIQU_SSH="-i $HOME/.ssh/zhiqu_server" bash deploy/ubuntu/deploy-from-dev.sh
```

DNS：`zhiqustudy.com`、`www.zhiqustudy.com` 两条 A 记录指向 `134.175.110.207`（www 只跳到主域名）。安全组放行 22、80、443。

A 记录加上之后**要重启 Caddy**：之前签证书失败的次数越多，它下一次重试隔得越久（失败十几次后是 6 小时），用户这时打开就是连不上：

```bash
ssh -i ~/.ssh/zhiqu_server ubuntu@134.175.110.207 'sudo systemctl restart caddy'
```

## 服务器上跑命令

默认关着。在这台机器上真跑一遍隔离的判据（真 bubblewrap、真 AppArmor、和服务同样的账号和限制），全过了才打开，跳过也不算过：

```bash
ssh -i ~/.ssh/zhiqu_server ubuntu@134.175.110.207 'sudo bash ~/zhiqu-StudySystem/deploy/verify-hosted-shell.sh'
```

要关：把 `config/application-prod.yml` 里的 `hosted-shell-enabled` 改回 `false`，`sudo systemctl restart zhiqu-backend`。

同一台机器上的隔离挡不住内核漏洞。要防这一层，命令得放到单独的机器上。

## RAG 旁路（语义检索，第一百二十二轮）

默认开着、跟着后端起停（后端的单元 `Wants=zhiqu-rag.service`，旁路 `PartOf=` 后端）；没起来时后端退回关键词检索。一个启用的索引都没有时，后端每 30 秒自己往前推一步（对账 → 建 → 启用，第一百二十四轮），不用去后台点；已经有在用的，换不换由管理员在后台定。每个人的索引分开：旁路按 userId + 资料编号过滤，后端只交这个人自己的编号。

在开发机上跑一条命令：在这边把 Linux x86_64 的 Python 3.11、只要 CPU 的 torch 和其余依赖、模型打成离线包（约 530MB，留在 `build/rag-bundle`，依赖没变就不重下），传上去、离线装好、重启一次后端：

```bash
ZHIQU_SSH="-i $HOME/.ssh/zhiqu_server" bash deploy/ubuntu/rag-from-dev.sh
```

服务器在国内，PyPI / GitHub / HuggingFace 慢或断，所以服务器上一个字节都不从外网下。模型默认取 `~/zhiqu/models/bge-small-zh-v1.5`（`rag-service/README.md` 第 2 步下的，带 `ZHIQU_MODEL_REVISION`），别处用 `RAG_MODEL_DIR=` 指。令牌、索引版本照后端的配置抄（`config/rag.env`，root:zhiqu 640），配置只把 `rag.enabled` 翻成 true、动之前留一份 `.bak-rag-…`。

旁路只听 127.0.0.1:8001、出不了网（`IPAddressDeny=any`）、内存到 850M 先压着、1000M 封顶（量过：Mac 上起来 407MB、建了索引 470MB；amd64 的 Linux 版 torch 起来 600MB、查完 672MB）。看状态：

```bash
ssh -i ~/.ssh/zhiqu_server ubuntu@134.175.110.207 'systemctl status zhiqu-rag --no-pager | head -5; sudo journalctl -u zhiqu-rag -n 30 --no-pager'
```

## 第一个管理员

注册出来的都是普通用户，库里也没有预置账号。注册好自己的账号之后，在服务器上把它提成管理员：

```bash
ssh -t -i ~/.ssh/zhiqu_server ubuntu@134.175.110.207 "sudo mysql zhiqu_db -e \"UPDATE sys_user SET role='ADMIN' WHERE username='你的用户名'\""
```

重新登录生效。

## 桌面应用

Mac 桌面应用（第一百二十五轮起）窗口里打开的就是这个网站，数据走网站的接口，不连这台的库 —— 主密钥、数据库密码不进任何安装包（`docs/desktop-remote-plan.md`）。
安装包放在 `data/downloads`（`app.desktop-downloads-dir`），网页上「下载桌面版」从这里拿。

Windows 桌面应用还带着自己的后端：MySQL 只听本机、不开到公网，所以它连的是本机的库。

## 以后更新

```bash
ZHIQU_SSH="-i $HOME/.ssh/zhiqu_server" bash deploy/ubuntu/deploy-from-dev.sh
```

先传到旁边再改名，传到一半断了服务还是用旧的。

## 看状态

```bash
ssh -i ~/.ssh/zhiqu_server ubuntu@134.175.110.207 'systemctl status zhiqu-backend caddy mysql redis-server --no-pager | grep -E "●|Active"'
```

```bash
ssh -i ~/.ssh/zhiqu_server ubuntu@134.175.110.207 'sudo journalctl -u zhiqu-backend -n 80 --no-pager'
```

## 踩过的

- `spring.profiles.active=prod` 是安全边界：磁盘接口、执行、密钥校验的门都看它。Windows 那份服务配置没写，这里单元和配置文件各写了一遍，`UbuntuDeployTest` 钉着。
- Ubuntu 默认不让普通程序建用户命名空间（`kernel.apparmor_restrict_unprivileged_userns=1`）。26.04 自带 `/etc/apparmor.d/bwrap-userns-restrict` 放开了 bubblewrap，放进去的命令一项能力都没有。**不要再加一份绑在 `/usr/bin/bwrap` 上的配置**：两份绑同一个程序算冲突（dmesg 里 `conflicting profile attachments`），哪份都不生效。
- 同样因为 AppArmor：命令 exec 时配置切换，内核会清掉 pdeathsig。所以不能用 `--as-pid-1`（命令当 1 号进程），不然外层一死里面的进程就成了孤儿。这个在容器里看不到，只有真服务器才撞得到。
- 单元里不要加 `ProtectKernelTunables`、`ProtectProc`、`ProcSubset`、`PrivateDevices`、`RestrictNamespaces`：bubblewrap 要建用户命名空间、挂新的 `/proc`，内核只在外面的 `/proc` 没被盖住时才允许。
- 整个服务的内存上限到了，先杀的是沙箱里的命令（`oom_score_adj` 是 1000）；`OOMPolicy=continue`，不然杀一条命令 systemd 就把整个服务停了。
