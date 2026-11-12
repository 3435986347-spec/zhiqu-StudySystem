# 第一百三十一轮：桌面应用里的斜杠命令和选择文件夹

用户 2026-11-12：斜杠命令面板和选择文件夹只有桌面版有，网页上没有。方案第 3 步（`docs/desktop-remote-plan.md`）把页面接到本机代码助手上。

## 要做的

- 网页（没有 `zqLocal`）：打 `/` 不拉出面板、回车不当成命令；不显示「选择项目」。档位还在，代码模式仍走服务器（生成到产物）。
- 桌面应用：打 `/` 拉出全部命令（`/mode` `/effort` `/model` `/project` `/web` `/new` `/init` `/review` `/help`）。选择文件夹走外壳的系统框。档位和文件夹记在这台电脑，不改服务器的工作区。
- 档位开着并且选了文件夹：这一轮交给外壳（`run`），步骤进回答，结束 `POST /api/ai/desktop-turn` 存回网站。草稿标 `desktop`，确认先 `apply` 写进选过的文件夹，再带 `desktopApplied` 标已确认。服务器不写磁盘。
- `apply` / `read`：相对路径，基线不符一个都不写，软链指到外面不写、不读。已经写成目标内容再确认一次算成功。

## 怎么验

- `slash-check.js`：桌面桥在时面板和命令还在；去掉桥，面板不出现、项目按钮藏着。扰动：`inDesktop` 恒为假，17 条变红。
- `DesktopTurnFilesTest`：`..` 进不了库。扰动：放开 `..`，断言说「出得去」。
- `DesktopLocalAgentTest`：真编译外壳，基线不符不写、软链外面没有文件、确认后磁盘是新内容、没选过的文件夹拒绝。

## 结果

- `slash-check.js` 全绿。扰动：`inDesktop` 恒为假，17 条失败（面板、上色、本机那一轮都没了），恢复后全绿。
- `ws-bar-check.js` 全绿。网页上即使后端给了路径，项目按钮也藏着；放上 `zqLocal` 才露出来。
- `DesktopTurnFilesTest`：放开 `..` 时断言说「出得去」（Failures，不是环境错），收紧后通过。
- `DesktopLocalAgentTest` 2/2。确认写盘：基线不符磁盘还是 `hello-project`，软链外面没有文件，写对之后是 `next`，再确认一次仍成功，没选过的文件夹被拒。
- `AiComposerTest`、`ClaudeMdTest`、`StaticAssetCacheTokenTest`、`PageModulesTest` 通过。缓存令牌 `20261112-r131`。
- 外壳改动要重打安装包才到已经装过的人手里。这一轮先部署网页。
