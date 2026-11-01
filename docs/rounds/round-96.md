# 第九十六轮（2026-11-02）：两份 coding agent 合成一份 —— 第 3 步（上）：命令行源码进 JAR、node 进桌面安装包

## 由来
第九十四轮定的三步（`round-94.md`）的第 3 步：删掉 Java 的循环、桌面应用带上 node 和命令行源码、部署说明。删 Java 的循环会去掉「起不来就退回」那条后路 ——
得先让 js 那份在桌面应用、网页服务器上都起得来。所以第 3 步拆成两轮：这一轮打包（js 那份到处都能跑），第九十七轮删 Java 的循环。

## 计划
1. 命令行源码打进后端 JAR（`classpath:zhiqu-cli/`，命令行没有 npm 依赖，src + package.json 就是全部）；找不到 zhiqu-cli 目录时 `JsCodeAgent` 解到临时目录用。
2. macOS 应用包带 node（`Resources/node/bin/node`），外壳把路径告诉后端；Windows 包带 `node\node.exe`。找不到 node 就不出包。
3. 部署说明：网页服务器什么时候要装 Node。
4. 判据先红；真打一次 macOS 包，用包里的 java、node 和 JAR 里带的源码起一个后端（验证库），真模型走一遍。

## 结果
- pom 的 `bundle-zhiqu-cli`（`copy-resources`）把 `zhiqu-cli/src/**`、`package.json` 放进 JAR；`JsCodeAgent.hostScript()`：配的目录 → 按工作目录找 → JAR 里带的（解一次）。
  判据：配一个不存在的目录也跑得起来，而且解出来的每个文件和源码一字不差（JAR 不会带着旧代码出去）。
- 打包脚本把 node 放进应用包、签名之前；外壳 `-Dapp.ai.code-agent.node=…` 加在 `-jar` 之前（原来那条「CDS 参数在最前」的判据照样过）；Windows 脚本带 `node.exe`、`--java-options` 用 `` `$APPDIR ``。
  判据 2 条（源码级：放进去、告诉后端、找不到就停；Windows 那条钉住 `` `$APPDIR `` 的转义）。
- **真打包**（`NODE_BIN=~/.local/node/bin/node`）：外壳编过、node v22.23.2 进了包（108M），应用 246M、dmg 147M；JAR 里 41 个命令行文件都在。
- **用包里的东西起后端**（包里的 java + 包里的 node + `cli-dir` 指向不存在的目录，强制用 JAR 里带的；验证库、EXEC 档的临时工作区、用户的 key）：
  头一回什么都没出 —— 解出来的源码在 macOS 的临时目录 `/var/folders/…`，那是 `/private/var` 的软链；宿主判「我是不是被直接运行」时，
  `import.meta.url` 是解过软链的、`argv[1]` 不是，两边对不上，`main()` 不跑，进程一声不响就退了。宿主改成比真实路径，后端也传真实路径；判据：经软链的路径起也要跑（回到老写法就红）。
  之后同一个请求：1 轮里读了 two_sum.py、跑了 test_two_sum.py（退出码 1），结论对。
- 部署说明（`deploy/windows/README.md`）：代码工作区只在后端绑回环地址时才开，普通的服务器部署用不到；真要开，装 Node ≥ 18.17。桌面说明见 `docs/notes/desktop.md`。
- 扰动：后端 3 处（不用 JAR 里带的、Windows 不转义 `$APPDIR`、外壳不传 node）、命令行 1 处（不比真实路径），全红。
- 三组判据：后端全量 1347（0 失败、0 跳过）、命令行 282/282、评测工具 99 过 1 跳。
