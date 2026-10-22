# 第八十二轮（2026-10-22）：网页版里下载桌面版（区分 macOS / Windows），放上打好的 dmg

## 由来
用户 2026-10-22（第八十一轮 review 时）：「在网页版里面增加下载桌面版的按钮，区分windows还是macos系统（苹果芯片），同时把打好的dmg给放进去」。

## 摸底（开工时）
- 网页版里没有任何下载桌面版的入口。
- 打好的 `build/desktop-native/知趣象限-1.0.0.dmg` 是 **114MB**：
  - 进不了 git —— GitHub 单个文件上限 100MB，推的时候会被拒；
  - 也不该打进 JAR（`static/` 下的东西都进 JAR）—— 桌面包里装着这个 JAR，等于安装包里再装一份安装包，每打一次涨一倍。
  所以 dmg 放在**服务器上的一个下载目录**里，后端按配置的目录提供（和上传目录 `uploads` 一个写法：`app.desktop-downloads-dir`，默认 `downloads`，相对后端的工作目录）。
- 这个包只能在 **Apple 芯片（arm64）、macOS 13 以上**跑（外壳和内嵌的 JRE 都是 arm64）；**只是本机临时签名、没有公证** ——
  别人下载后第一次打开，macOS 会说「无法验证开发者」，要在「应用程序」里右键 →「打开」。下载的地方要写清这两件事。
- Windows 安装包只能在 Windows 上打（`deploy/desktop/package-windows.ps1`，jpackage）：现在没有，下载的地方照实说「还在准备」，放上去以后自己出现。
- 网页版跑在用户的服务器上（数据库也在那边）：我能把 dmg 放进本机这份后端的下载目录、在内置浏览器里验，服务器上那份要用户拷过去（写清楚放哪）。

## 计划
1. 后端：`GET /api/desktop/downloads` 列出下载目录里各平台最新的那个安装包（文件名、版本、大小、SHA-256）；`GET /api/desktop/downloads/{macos|windows}` 下载（附件、中文文件名、能断点续传）。
   只认这两个平台名，文件名不从请求里来；两条都不用登录（落地页上要能下）。
2. 前端：一个下载弹窗（共用层），落地页一个按钮、头像菜单一项打开它；认出这台电脑是 Mac 还是 Windows，把那个放前面、标「你的电脑」；
   Mac 那项写清 Apple 芯片、macOS 13+、第一次打开右键 →「打开」；能认出是 Intel 的 Mac（Chromium 给得出芯片架构）就直说装不上；
   Windows 没有安装包时不给按钮、照实说；桌面应用里不出现这个入口。
3. 打包脚本：设了 `ZHIQU_DOWNLOADS_DIR` 就把 dmg 拷进去；`downloads/` 进 `.gitignore`。本机这份后端的下载目录里放上现在这个 dmg。
4. 判据先红、扰动见红；内置浏览器里真下载一次（比对 SHA-256、断点续传）、暴力（连点、Windows 的样子）；桌面应用里点一遍（菜单里不该有这项）；全量；换缓存令牌。

## 结果

**后端**
- `DesktopDownloads`（`service/desktop/`）：每个平台取下载目录里最新的那个（按修改时间）；版本从文件名认，SHA-256 按「路径 + 大小 + 修改时间」记住
  （一百多 MB 不能每次列表都算）；点开头的、符号链接、子目录、别的扩展名一律不认。目录不存在就是两个 null。
- `DesktopDownloadController`：`GET /api/desktop/downloads` 列表；`GET /api/desktop/downloads/{macos|windows}` 回 `Resource` ——
  附件、中文文件名按 RFC 5987、`X-Content-SHA256`，Range 由 Spring 处理（206）。不认的平台、没有的包 404；文件名从来不从请求里来。
- `SecurityConfig` 只放行这两条（`/api/desktop/downloads`、`/api/desktop/downloads/*`）；`app.desktop-downloads-dir` 进 `application.yml` 和生产模板（`C:/zhiqu/downloads`）。
  dmg 的类型不在压缩名单里（真 Tomcat 上量过不压）。
- `downloads/` 进 `.gitignore`；`package-macos-native.sh` 设了 `ZHIQU_DOWNLOADS_DIR` 就把 dmg 拷进去（这一轮就是这么放的）——
  自查时补上：先拷成点开头的 `.part` 再改名，拷到一半时后端不认它（原来直接拷，拷的那十几秒里有人点下载会拿到半个包）。

**前端**（共用层 `zhiqu-api.js` 一段「下载桌面版」，样子在 `zhiqu-ui.css` 的 `.zq-dl*`，没有新的内联样式）
- 落地页英雄区第三个按钮、头像菜单「界面风格」下面一项，打开同一个弹窗；桌面应用里头像菜单不画这项，落地页的按钮由 `html.zq-desktop` 藏起来。
- 认电脑：先信平台字段（`userAgentData.platform` / `navigator.platform`），都没有才看 UA；iPad 的 Safari 自称 MacIntel，靠触点数分出来。
  Chromium 给得出芯片架构：认出是 Intel 的 Mac 就直说装不上（按钮照给）。这台电脑那项排前面、标「你的电脑」、是主按钮；
  手机 / Linux 说桌面版只有这两种。Mac 写清 Apple 芯片、macOS 13+、第一次打开怎么放行（「仍要打开」/ 说「已损坏」时的 `xattr` 那一行）；
  Windows 没有包时照实说「还在准备」、不给按钮，放上来以后自己出现（`.exe` 写安装、`.zip` 写解压、SmartScreen 怎么放行）。
  末尾写明桌面版要连一个 MySQL（`.zhiqu/application.yml`）。
- 下载是普通的 `<a href download>`，交给浏览器自己的下载（有进度、能续），不经 fetch 读进内存；连点只开一个；开着时焦点在关闭按钮上；
  关掉之后才回来的列表不往里写；没取到就说原因、给「再试一次」。

**开工后发现的**
- 模拟 Windows 时，平台字段说 Windows、UA 里却有 Macintosh，判成了 Mac（原来是「平台或 UA 有一个像 Mac 就算 Mac」）—— 改成先信平台字段。
- 下载的人要有 MySQL：桌面版自带后端、默认连本机 `zhiqu_db`；没有库时后端重试 48 秒后退出、外壳报「后端没有在 60 秒内就绪」（量过）。
  这是这个包本来的样子，不是这一轮改的 —— 弹窗里照实写，记进 `docs/notes/desktop.md`，要不要做成「连网页版的服务器」等用户定。
- Gatekeeper：从 dmg 拷出来、加上隔离属性的副本 `spctl` 判 rejected（`Signature=adhoc`，签名本身 `codesign --verify --strict` 有效）；
  可执行文件 arm64、`LSMinimumSystemVersion` 13.0 —— 和弹窗里写的一致。没在屏幕上弹系统的拦截框（那要点「仍要打开」，属于改安全设置）。

**判据**（新 7 条 Java + node 41 条）
- `DesktopDownloadTest` 5 条：挑哪一个（最新、版本、SHA-256、换了内容重算；点开头 / 符号链接 / 目录 / 别的扩展名不认）、没有的时候、
  接口（附件 + 中文文件名、类型、校验值、Range 206、404）、弹窗的行为（node 跑 `desktop-download-check.js`，喂它真的 `DesktopDownloads` 列出来的回包）、
  入口（落地页一个、菜单一项、桌面应用里都不出现、安装包不进 git / static）。
- `DesktopDownloadIntegrationTest` 2 条（真库、真过滤器链、真 Tomcat）：没登录能列、能下、不压、Range 206；放行不放宽（`/api/desktop` 下别的照样 403）、拼路径绕不出去。
- 扰动 18 处全红（第 18 处是下面改过的 `SettingsDialogTest`：壳不交 `logout`）：iPad 当 Mac、UA 压过平台字段、连点开两个、关掉之后还往里写、版本不转义、Intel 不提醒、桌面应用里菜单照样有、落地页按钮不藏、
  挑最旧的、认符号链接和目录、认点开头的、校验值只按路径记、不是附件、没有的包回 200、放行漏了下载（403）、放行放宽到 `/api/desktop/**`、安装包被 gzip。

**实测**
- curl：列表的 SHA-256 和 `shasum` 一样；分两段下（`-r 0-49999999` 再 `-C -`，都是 206），拼起来 SHA-256 一样；windows / linux 404。
- 内置浏览器（落地页没登录）：弹窗 macOS 在前、标「你的电脑」，芯片认出是 arm、不提醒；在页面里把整个包取一遍算 SHA-256 和弹窗里写的一样（没存进下载文件夹）；
  尾巴 577 字节的 Range 206 对得上。暴力：连点按钮 10 次只开一个；Esc 关；开了马上关不留东西、再开正常；
  手机宽 375 + 浅色（模拟成安卓）：说「只有这两种」、没有横向滚动；模拟 Windows + x86：Windows 在前、Mac 是次要按钮、不提醒 Intel；
  放一个临时的 `.exe`：出按钮、SmartScreen 的说明、附件头对（之后删掉）；列表请求连断 3 次：请求层重试完照实说、「再试一次」取回来。
  登录测试账号（验证库）后头像菜单里有这一项、点开同一个弹窗、菜单收起。
- 桌面应用（用这一轮的代码重打，连 `zhiqu_verify`）：computer use 点开头像菜单 —— 设置 / 成就 / 专注统计 / 界面风格 / 退出登录，没有「下载桌面版」。
- 全量第一遍 1308 条红 5 条（4 条是真的）：
  `DesktopUploadDirTest` —— 新的 `app.desktop-downloads-dir` 是相对的，桌面版的工作目录是 `/`，`application-desktop.yml` 要给绝对的（`~/.zhiqu/downloads`）；
  `PageModulesTest` —— 弹窗里的内层函数叫 `load`，和知识 Wiki 模块自己的 `load(` 同名，判据当成模块越过 `zqShared` 调壳（改名 `loadListing`）；
  `SettingsDialogTest` 钉着导出对象以 `logout: logout };` 结尾 —— 改成看导出对象里有没有 `logout`，不看顺序（扰动见红）；
  `HomeCarouselTest` 落地页图标占位 5 → 6（多了下载按钮）；另一条 `ClaudeMdTest` 是 README 那一行在它跑过之后才加的。
- 全量第二遍（`mvn -o clean test`，Docker 开着）：1308 条，0 失败、0 跳过。

**要用户做的**
- 服务器上那份：把 `知趣象限-1.0.0.dmg` 拷到 `C:/zhiqu/downloads`（生产配置里加 `app.desktop-downloads-dir`，模板里有），先用点开头的名字拷、拷完改名。
- Windows 安装包要在 Windows 上打（`package-windows.ps1`），打好放同一个目录就出现。
- 下载的人要有 MySQL 才能用桌面版 —— 要不要把桌面版改成「连网页版的服务器」等用户定。
