# 第一百一十九轮（2026-11-08）：部署到服务器

## 由来
用户：「全部弄完后部署到服务器上，域名可以用zhiqustudy.com，ip是134.175.110.207 用户名是ubuntu，放在zhiqu-StudySystem文件夹里…服务器是ubuntu」「备案了」「原来数据不用管了，就是重装了」。

## 计划
1. `deploy/ubuntu/`：配置模板（生产 profile、`hosted-enabled` 开、`hosted-shell-enabled` 先关）、systemd 单元（专门的 `zhiqu` 账号、内存上限、`OOMPolicy=continue`）、Caddy、AppArmor（只放开 bwrap）、MySQL / Redis 的小内存配置、产物临时空间单独一块小文件系统、备份、安装和更新脚本。密钥在服务器上现生成，不打印、不进仓库。
2. 装好、起服务。
3. 在真服务器上跑隔离的判据（`sandbox-hosted.test.js`，真 bubblewrap、真 AppArmor、和服务同样的账号和限制）。全过才打开服务器上跑命令，否则只生成文件，照实说。
4. 验：生产 profile 真的生效（磁盘接口拒绝）；真浏览器里走一遍注册、配模型、生成文件、跑命令；对外的 80、443 通不通；HTTPS 看 DNS。
5. 判据：`UbuntuDeployTest` 钉住模板和单元里不能丢的东西。

## 结果

**部署好了**：`/home/ubuntu/zhiqu-StudySystem`，专门的 `zhiqu` 账号（`ubuntu` 有免密 sudo，所有注册用户都能叫起命令的进程不能跑在它下面），systemd + Caddy + MySQL + Redis，服务器上生成文件和跑命令都开着。重启过一次，磁盘挂载、服务都自己回来了。库是空的：测试账号和数据都清了（确认过只有 `r119_` 开头的账号才重置）。

**还差用户的一步**：`zhiqustudy.com`、`www.zhiqustudy.com` 没有 A 记录（NS 在 DNSPod，SOA 有，记录没有），证书签不下来。80、443 从外面通的（安全组放行了）；8080、3306、6379 外面连不上（本机的代理会替它们答 TCP 握手，要读回包才算数，第一次看到全 open 差点信了）。

## 真服务器上撞出来的（容器和单元判据都看不到）

1. **我加的 AppArmor 配置和系统自带的冲突**。Ubuntu 26.04 自带 `bwrap-userns-restrict`，再加一份绑 `/usr/bin/bwrap` 的，内核算 `conflicting profile attachments`，哪份都不生效，bubblewrap 起不来。隔离判据 16 条跳过，`verify-hosted-shell.sh` 没放过（跳过不算过）。删掉我那份，自带的更严（放进去的命令 `audit deny capability`）。
2. **到点杀不干净**。判据「到点连里面的进程一起杀」卡了八分钟：`sleep` 变成孤儿活着，攥着管道。`--as-pid-1` 让命令当 1 号进程，exec 时 AppArmor 切配置，内核把 `--die-with-parent` 设的 pdeathsig 清了（量过：`pdeathsig 0`；杀外层后不带 `--as-pid-1` 剩 0 个、带的还活着）。第一百一十七轮加它是为了不让 `/proc/1/cmdline` 露出真路径，现在换成 `--args`（参数放文件、打开就删、bwrap 读完就关），1 号留给没 exec 过的 bwrap，`env -i` 让它的环境是空的。
3. **auto 档的命令写不了 `/work`**。`shellWrite` 看 `canExec`，那是「白名单命令能不能跑」，生产 profile 下恒为假，所以服务器上每一档都是只读，第一百一十七轮的功能其实没通。那一轮的判据直接把 `canExec=true` 传进去，容器判据测的是沙箱本身，两边都绿。现在看档位本身。
4. **生产判定没人设**。Windows 那份服务配置没写 `spring.profiles.active`；这次单元和配置文件各写一遍，真的打过：走隧道算本机请求（最宽松的情况）`pick-folder`、`browse`、`file` 都拒，`root=/etc` 被丢掉。

## 验证

- 部署判据（`UbuntuDeployTest`）和档位那条，28 个扰动全红。第一轮「密钥少替换一个」是绿的：建库那行也提到同一个占位符，`contains` 被骗过了，改成对照替换表。
- 真服务器上 `sandbox-hosted.test.js` 23/23，0 跳过（真 bubblewrap 0.11.1、真 AppArmor、`zhiqu` 账号、和服务同样的限制）。容器里 23/23，新的 6 个扰动全红。
- 端到端（服务器本机的假模型，不花钱；经 SSH 隧道）：
  - 生成并运行：`write_file` + `python3 main.py > out.txt`，产物出现、下一轮还在、预览读得到 `hello from server`。
  - 探测：根目录只有 `bin dev etc lib lib64 proc sbin tmp usr work`；`/home`、`/root`、`/var`、`/run`、`/etc/shadow`、配置文件都不存在；MySQL、Redis、后端、自己的公网 IP、元数据、外网都不通；`CapEff=0`、`NoNewPrivs=1`、seccomp 开着、`bwrap//&unpriv_bwrap`；`/usr`、`/etc` 写不了；再建命名空间失败；环境变量里没有密钥。
  - 吃内存：涨到 1450M，内核在这个服务的 cgroup 里杀了 `python3`（`oom_score_adj:1000`），后端 `NRestarts=0`。
  - 写满磁盘：单独那块 4G 满了（`wrote=65`），根盘不受影响，MySQL 照常。
  - fork 炸弹：`fork: retry` 之后结束，残留 0。
  - 卡死：`sleep 987654 & sleep 987654` 60 秒被杀，残留 0，下一条照常。
- 真浏览器（经隧道）：面板里不列 `/project`、`/init`、`/review`，打 `/review` 说「服务器上没有项目文件夹」，`/model 假` 切模型，生成的文件能预览、下载。
- 备份跑过一次（`zhiqu_db-*.sql.gz`、`files-*.tar.gz`，root 700）。

## 收尾：A 记录加上之后打不开（用户 2026-11-08 报的）

1. **证书没签**。A 记录加上之前 Caddy 已经失败了 12 次，下一次重试排到了 6 小时以后（`retrying_in 21600`）。我在 Caddyfile 里写的「加上就好，不用重启」是错的。`sudo systemctl restart caddy` 之后 1 秒签下（Let's Encrypt 正式证书，主域名和 www 各一张，2027-02-06 到期，Caddy 自己续）。Caddyfile 的注释和 README 改成「加上之后要重启」。
2. **www 是单独一个源**。原来 `zhiqustudy.com, www.zhiqustudy.com` 挂同一个应用：两个源的登录（localStorage）和 Service Worker 各算各的，在 www 登录了换到主域名还得再登。改成 www 用 301 跳到主域名（路径、参数都带上）。
3. **流式接口只列了一个**。`@sse` 原来只有 AI 助手的回答；命令行经服务器的模型网关、参考计划和后台的事件也是 SSE。四个都列上，`UbuntuDeployTest` 从控制器里找出所有返回 `SseEmitter` / produces `text/event-stream` 的接口，要求和 `@sse` 一一对上（后端新加一个会红）。

验证：

- `UbuntuDeployTest` 新的一条，9 个扰动全红（www 也挂应用、www 不跳转 / 跳错、`@sse` 漏一个 / 多一个、缓冲、后端改了路径 / 前缀 / 不带 produces 的那种）。
- 服务器上 `caddy validate` 过了再换；www → 301 主域名、http → 308 https、裸 IP → 301 域名。
- 经 Caddy 的流式回答（服务器本机的假模型隔 1 秒吐一个字，经 127.0.0.1:443、SNI 是 zhiqustudy.com、校验证书）：不带压缩、gzip、zstd、浏览器那一串，四次都是一秒到一个字（0.05、1.05、2.05、3.05、4.05 秒），Caddy 不压缩事件流，`encode` 不会攒。测试账号测完按 id 删干净（`ai_agent_task` 有指向自己的外键，第一遍一次删不掉；按外键的顺序删，每张表核对是 0 行），这时用户已经注册了自己的账号（id 1），没碰。
- 内置浏览器：www 跳到主域名、`isSecureContext`、走 HTTP/3、Service Worker 激活并接管页面、缓存 `zhiqu-shell-v20261108-r118a` 建好，控制台没有错误。中间有几分钟面板里对这个站的请求全卡住（服务器本机同时取是 20 毫秒，这台 Mac 走的代理一个样式表要 0.7–2.6 秒），之后自己好了；服务器上抓包看 UDP 443 两个方向都有包，HTTP/3 是通的，没有关它。

## 还没验的、挡不住的

- 真模型没跑（要花钱，没问）。
- 同一台机器上的隔离挡不住内核漏洞；一个账号能把 4G 的临时空间写满（只影响别人生成文件，三天清一次，没有按账号的配额）。
- 备份和数据在同一台机器上。
