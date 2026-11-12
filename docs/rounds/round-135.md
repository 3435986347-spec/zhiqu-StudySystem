# 第一百三十五轮（2026-11-12）：模型能自己看页面了（预览截图）

## 由来

用户先问「为什么沙箱不能跑 Chrome」，确认了是设计边界（Seatbelt 只放 6 个 mach 服务、家目录读不到；
bwrap 的 `--disable-userns` 让 Chrome 的渲染进程建不了自己的命名空间），随后说：

> 让他预览自己的页面 —— 给模型看（截图自检）

所以不是把 Chrome 塞进沙箱，而是换一条路：**截图在宿主进程里做**。

## 要做的

- `zhiqu-cli/src/tools/preview.js`（新）：
  - `findChrome()`：`ZHIQU_CHROME` 优先，否则找 macOS / Linux 常见安装位置；找不到就不下发这个工具。
  - `serveDir(root)`：只监听 `127.0.0.1` 的只读静态服务，只给工作区里的文件（`..` 与编码过的跳出一律挡）。
  - `shoot()`：无头 Chrome（`--headless=new`、临时 profile、`--virtual-time-budget=3000`、`--screenshot`），
    超时 SIGKILL，profile 用完就删。
  - `screenshotPage()`：文件或目录（要 `index.html`），只收 `.html`，超过 1.5MB 让模型调小窗口而不是硬塞。
- `local.js`：新增 `preview_page` 工具（只读），截完把图挂在 `pendingImage` 上。
- `agent.js`：`toolset` 只在**宿主机**这一份下发（`hosted` 的服务器 / 桌面后端那份跑不了浏览器）；
  工具结果之后补一条带 `image_url` 的 user 消息 —— 工具消息只能是文本，OpenAI 和 Anthropic 都只在 user 里收图。
- 后端两处（不然图会撞坏现有的估算和转换）：
  - `HarnessContext.estimateContent`：内容块数组里的图按 **1200 token** 估，**不按 base64 字数**。
    一张 200KB 截图 base64 有 27 万字，按文本估是 7 万多 token，整个窗口会被一张图占满、历史被整段裁掉。
  - `AnthropicFormat.userBlocks`：把 `data:image/png;base64,…` 拆成 Anthropic 的 `image` 块。

## 怎么验

- `zhiqu-cli/test/preview.test.js`（4 条）：找浏览器、静态服务的目录穿越、假浏览器真跑一遍截图、
  目录取 `index.html`；非 html / 找不到 / 浏览器崩了都照实说。
- `HarnessContextTest.图片不按字数估`：20 万字符的 base64 估出来必须 < 2000 token。
  扰动（改回 `String.valueOf(content)`）见过红。
- `AnthropicFormatTest.截图按图片块发`：两块（text + image），`media_type` / `data` 都对。
- 手工接线验证：设 `ZHIQU_CHROME` 指向假浏览器，`toolset` 里出现 `preview_page`，`previewPage` 取得到图、
  取过一次就清空。

## 结果

- 命令行全量：见下（本轮新增 4 条）。
- 后端 `HarnessContextTest` 5 条、`AnthropicFormatTest` 7 条、`HarnessModelGatewayTest` 25 条全过。

## 边界

- 只在**命令行（终端里的 `zhiqu`）**有。桌面应用那份命令行源码打在安装包里，要重打包才有；
  网页 / 桌面后端的代码模式（hosted）不给这个工具 —— 那里没有浏览器。
- 页面是在一个没有登录态的临时 profile 里渲染的，但它跑在**沙箱外**（宿主进程）。截图用的浏览器
  本身是系统装的 Chrome，页面里的脚本能发网络请求 —— 和用浏览器打开一个陌生页面同级。
- 模型不支持看图时，这一轮会收到供应商的 400；报错照实显示，不会静默失败。
