# 第一百二十轮（2026-11-08）：带宽小的服务器上不卡、安装包放上去

## 由来
用户：「是因为我开了代理吗，连接网页直接卡死了」「网页安装包上面的是最新的吗」。查了：

- **不是代理**：代理对这个站本来就是直连（服务器看到的来源是用户的广州联通出口），ping 12ms、不丢包，几百字节的请求 45ms 回来。
- **是带宽**：服务器（BF1.MEDIUM2，广州七区）公网下行实测每秒 150–190KB，约 1.5 Mbps。第一次打开首页要下约 1MB（首页直接引用的压缩后约 570KB，其中 8 张截图懒加载；Service Worker 预取 42 个文件压缩后 502KB），这些请求挤在同一根管子里。
- **我们自己的问题**：静态文件回的是 `no-cache, no-store`（`WebMvcConfig` 只给 `/service-worker.js` 设了缓存头，别的没设，Spring Security 给没有 Cache-Control 的响应一律补 no-store），浏览器一个都不存 —— 每切一个页面，160KB 的样式表、170KB 的壳重下一遍。Service Worker 是「先走网络」，有网的时候一点忙都帮不上。
- **安装包**：服务器重装后下载目录是空的，网页上的下载按钮下不到东西；本机最新的 dmg 是 11-05 打的，比现在的代码旧十几轮。

用户定了：带宽**先不升级**（我把能省的都省掉）；安装包**重新打 macOS 包放服务器**。

## 计划
1. 静态文件让浏览器存着、每次核对（`private, no-cache` + Last-Modified；没改过回 304、不带正文）。不给 max-age：令牌忘了换也不会让用户拿着旧的。接口照旧 no-store。
2. Service Worker 等页面加载完、再过 3 秒才注册（它的预取不再和页面抢带宽）；预取的只留普通用户每天要开的（后台四页、KaTeX 和它的 20 个字体不预取，用到时 fetch 处理器照样缓存）。
3. 判据：真 HTTP 的缓存头和 304（`NetworkCompressionIntegrationTest`）、node 跑发布的 `maintainShellCache`、预取的清单和 gzip 后的预算（`SlowNetworkBudgetTest`）。
4. 用现在的代码打 macOS 包、部署后端、把安装包传到服务器的下载目录；在真服务器上量第一次打开、第二次打开各下了多少。

## 结果

- `WebMvcConfig`：`/assets/**`、`/vendor/**`、`/*.html`、`/favicon.ico`、`/manifest.json` 都是 `private, no-cache`。第一次写成一个 handler 指到 `static/`：`/assets/**` 交给目录的是去掉前缀的那段，全都找不到，找不到又按业务错误回 200 + 55 字节的 JSON —— 页面脚本全成了这 55 个字节。原来那条压缩判据（逐个比对解开后和原文一样）当场照出来了；改成每个前缀各指各的目录。
- Service Worker 预取：42 个、压缩后 502KB → 16 个、166KB；预算定 200KB。
- 扰动 18 个全红（每一类路径不设缓存、不标 private、改成 no-store、指回 static/、一打开就注册、不再等、监听不是一次性、已加载完不注册、去掉协议判断、后台页 / KaTeX / 字体回到预取、预取不存在的文件、超预算）。

## 同一轮：命令行默认连网站、准备发布到 npm

用户：「为什么还是连接本地的，你设置成默认连接这个网址的」「同时发布npm，让用户运行npm install zhiqu可以下载」（这就是 P7，原来定的「发布前单独问用户」，这句就是答复）。

- `zhiqu-cli/package.json`：`zhiqu.defaultServer` 从本机桌面应用（`http://127.0.0.1:47615`）改成 `https://zhiqustudy.com`，去掉 `"private": true`；`check-release` 通过。包名 `zhiqu` 在 npm 上没人用。`npm pack` 看过：48 个文件、压缩后 179KB，只有 `bin`、`src`、`package.json`、README。
- README 照现在的样子重写（它是 npm 上的介绍页）：安装（国内换 npmmirror）、注册加模型、登录、三档、系统沙箱、命令；原来还写着「不经过 shell、不接受行内代码」，那是第一百零九轮之前的。
- 用户这台 Mac 的 `~/.zhiqu/config.json` 存着本机地址和本机的令牌，优先级高过默认值：备份成 `config.json.bak-local`，去掉这两项（本机的令牌不该发给网站）。
- `misc.test.js` 原来钉着「仓库里的这一版不能发布」，照用户的决定改成「默认就是 https://zhiqustudy.com、能发布」；三个扰动（改回本机、换成 http、private 加回去）全红。
- 评测工具顺带撞出来的：`run-repository` / `run-humaneval` / `repository-docker` 没指定服务器时借的是命令行的默认值，而评测只该连本机的网关（`assertLoopbackServer`）—— 默认值一改、用户配置里的本机地址一去，预检那条就红了。改成明确用 `LOCAL_DESKTOP_SERVER`；那条测试原来还读这台机器真实的 `~/.zhiqu`（用户登录了网站它就会红），改成注入。两个扰动（默认借网站、不认注入）全红，模拟「已经登录了网站」照样绿。
- 发布本身要用户先在 npm 上注册、`npm login`（账号和密码只能用户来）。用户注册时页面说「访问受限」：代理对 npmjs.com 走的是韩国的节点（203.248.84.72），被 Cloudflare 拦了；换节点或让 npmjs.com 直连。
