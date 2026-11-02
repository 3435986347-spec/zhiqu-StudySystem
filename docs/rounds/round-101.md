# 第一百零一轮（2026-11-02）：macOS 打包不再把依赖 Homebrew 的 Node 当成独立文件

## 由来

用户本机运行 `package-macos-native.sh`，JAR 与 JRE 都成功，复制 Node 后报 `Library not loaded: @rpath/libnode.147.dylib`。
PATH 上的 Homebrew Node 26.8.2 依赖 libnode、OpenSSL、ICU 等外部库；第九十六轮只复制了一个可执行文件，验证时用的是另一台机器上的独立 Node，因此没有发现。

## 计划

1. 默认准备固定版本的官方 macOS ARM64 Node 22，固定 SHA256 校验、缓存放在不会被清理的 `build/node-runtime`，附带 LICENSE。
2. 保留 `NODE_BIN` 覆盖；在 Maven 和删除旧产物之前校验架构、最低 macOS 版本、动态库依赖及 Node 版本，明确拒绝依赖 Homebrew 的文件。
3. 回归验证要覆盖真实 Mach-O 依赖与缓存失败；见过红再绿。重新打出安装包，检查签名、移动到中文/空格目录后运行 Node、执行 ESM 与子进程探针。
4. 更新打包说明与轮次索引。此次不改页面；浏览器暴力测试不适用于打包故障，改为打包产物与错误输入验证，不启动桌面应用或连接真实数据。

## 结果

- 新增 `prepare-macos-node.sh`，默认固定官方 Node **22.23.2 / darwin-arm64**；从官方 `SHASUMS256.txt` 核对并将 tar.gz 的 SHA256 固定为 `61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6`。缓存不在会清理的 `desktop-native` 中，每次校验归档并重新解出运行时，只带 node 与 LICENSE。
- 默认不再读取 PATH 上的 Node；显式 `NODE_BIN` 仍可用。真实 `lipo` / `otool` 检查 ARM64、最低 macOS ≤ 13.0.0、只依赖系统动态库，并用干净环境执行 `--version`（Node ≥ 18.17，与 CLI 的 engines 一致）。缺库、缺许可证、下载失败都在 Maven 与清理旧包前停止。
- 不再吞掉签名失败；Node 单独重签后对整个应用签名、严格验证，签名后再次运行包里的 Node。
- **真实本机复现**：指定 `/opt/homebrew/bin/node`，现在直接说明 `@rpath/libnode.147.dylib` 是外部库；不会再构建到一半才报 dyld 错。已有成功 DMG 的大小与 SHA256 在这次失败前后逐字节一致，应用也保留。
- **行为判据**：`python3 deploy/desktop/tests/test_macos_node.py -v`，10/10，0 错误、0 跳过；真实编译 Mach-O，覆盖中文 / 空格路径、ARM64、13.1 / 14.0、旧版 Node、可以在本机运行但依赖 @rpath 的文件、下载与缓存 SHA256、离线使用官方缓存。官方运行时搬到另一目录后，ESM、crypto、spawn 均通过。
- **见红**：先跑旧版打包测试 9/9 绿，改连接判据后旧脚本为 1 Failure / 0 Errors，再改实现转绿。行为判据的 5 组临时副本扰动（删除外部库检查、放宽系统 / Node 版本、去掉下载校验、缓存不重新校验）合计 6 个真实断言失败、0 Errors，各组合法样本对照全绿。SHA 样本是能解包 / 能运行的伪造归档，不靠 tar 错误冒充拒绝。扰动副本在源码外，已清理。
- **相关 Maven 判据**：JDK17，`mvn -o test -Dtest=DesktopPackagingTest,ClaudeMdTest,DesktopPageViewTest,WebAppManifestTest -Dzhiqu.skipDockerTests=true -q`，28/28，0 失败 / 错误 / 跳过；其中 PageView 在隐藏的真实 WebKit 窗口验证。此次没有 API、业务或页面改动，没有跑后端全量 / Docker / 模型请求，也未启动桌面应用连接真实数据。
- **完整打包成功**：直接运行用户原命令；JAR 76MiB、JRE 56MiB、Node 108MiB，应用 240MiB、`build/desktop-native/知趣象限-1.0.0.dmg` 为 149,818,155 字节（约 143MiB）。`hdiutil verify` 成功；只读挂载 DMG 后对其中应用执行 `codesign --verify --deep --strict` 成功，检查 LICENSE 与 Applications 软链。取出 DMG 内的 Node 搬到中文 / 空格目录，用干净环境验证 ARM64、ESM、crypto、子进程（42），只依赖系统库。验证挂载与临时文件已清理。
- 文档同步 `deploy/desktop/README.md`、`docs/notes/desktop.md`；CLAUDE 保持 200 行，缓存令牌未变（没有前端改动）。独立 review 已完成，无剩余阻断项。macOS 13 兼容性按 Mach-O 最低系统版本检查，未在另一台 macOS 13 机器上运行整套应用。
