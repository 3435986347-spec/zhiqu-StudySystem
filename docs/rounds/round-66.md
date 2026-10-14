# 第六十六轮（2026-10-14）：Wiki 嵌入预览、编辑快捷键与滚动稳定性

## 用户问题与计划

- 部分页的六级 Markdown 标题显示为原始 `######`；补齐六级标题的阅读、编辑和往返保存。
- macOS 桌面应用的全选、复制和粘贴快捷键不可用；修复原生菜单和响应链，用不显示窗口的独立 WebKit 验证，保留用户剪贴板。
- `![[笔记]]` 被误认为图片，JSON 等普通附件只能下载；参考 Obsidian 官方嵌入与格式说明，按类型显示笔记、图片、PDF、音视频、JSON/文本，以及其他附件卡片，保留鉴权和原 Markdown。
- index 备注自动截取了杂乱正文和内部附件路径；改成适合目录阅读的信息，避免把原文中的账号、标识与技术路径塞入目录。
- 点编辑和保存后正文上下跳动；保持阅读位置与焦点，验证长文、标题、嵌入和保存失败时的行为。
- 新行为先见真实断言失败，再修复；合成服务和独立 WebKit 验证，不修改真实 Wiki、ZIP、数据库，不运行模型。
- 完成缓存和必要截图更新，离线测试、审查、提交并推送。

## 官方参考

- [Obsidian 嵌入文件](https://obsidian.md/help/embeds)：笔记及小节/块嵌入、图片尺寸、音频、PDF 页码和高度、Canvas。
- [Obsidian 支持的文件格式](https://obsidian.md/help/file-formats)：Markdown、Bases、Canvas、图片、音视频与 PDF；编解码支持随设备变化，其他格式可由插件扩展。JSON 正文预览是本轮按用户要求补充的能力。
- [Obsidian 基础格式](https://obsidian.md/help/syntax)：标题支持 1–6 级。

## 实现与验证

### 文件与笔记预览

- 导入/导出保留 `![[...]]`、笔记小节/块锚点和附件嵌入，笔记嵌入加入关系图。已知带点的页名优先当作笔记；明确写错目录的引用保持未找到，不用别处同名页替代。
- 新增本人附件列表 `GET /api/knowledge/attachments` 及类型化预览 `GET /api/knowledge/attachments/{id}/preview`；JSON/文本直接显示原文，PDF、图片、音视频通过鉴权下载后生成类型受限的 Blob。Canvas 显示节点、连线和可展开的原文；未知格式显示文件卡片和下载入口。
- 用户指出 JSON **确实被正文引用**。只读核对原 ZIP 中有 JSON 嵌入；兼容旧导入把非图片嵌入 `!` 丢掉后留下的普通附件链接，JSON 原位自动展开，无需重新导入。原始 ZIP 和笔记内容未进入提交或截图。
- 保留 Markdown 原文，不把预览内容、格式化别名或嵌入表格复制进父页面。文本严格 UTF-8、服务端最多 512 KiB，客户端最多 64 KiB；JSON 格式化后超限也提示截断。SVG/HTML 等显示转义源码，不作为活动文档运行。
- 每次请求和迟到响应检查登录身份；笔记嵌入限制 4 层、24 次及 200K 总文本。下载保留原接口和鉴权。

### 目录、标题与编辑

- 支持 H1–H6；重复页名在阅读和排版编辑时使用同一隐藏规则，源码中仍保留。
- index 按类型列出页面双链，不再复制正文摘要、账号、内部地址和图片路径；正常读取系统页即可更新旧目录。
- 读/编辑操作区保留同高，聚焦不滚动，保存、取消和异步嵌入加载恢复可见段落锚点；源码模式记住进入前的位置。重复段落优先匹配原位置，再找最近同文段落。
- 保存期间的新输入和已离开页面的较新草稿不会被迟到回执覆盖；取消仅清除当前页草稿，保留其它页草稿。

### macOS 快捷键

- 原因是宿主缺少原生编辑菜单。增加标准 AppKit 菜单，通过当前 responder chain 处理全选、复制、剪切、粘贴、撤销、重做。
- 独立 `.nonPersistent` WKWebView 实测 contenteditable 和 textarea 的快捷键；窗口保持隐藏、非 key，剪贴板每次操作后恢复。
- **必须重新打包桌面 `.app`，仅替换 JAR 或重启旧包不会让原生菜单改动生效。**

### 真实浏览器验证与截图

- 使用本机合成 API 服务，无真实数据库或模型。旧 JSON 普通链接直接展开；小节嵌入不带入同级其它小节；H6、音频控件、Canvas 节点/边、未知文件卡片及附件列表可见。
- 本机真实 `.nonPersistent` WKWebView 另测 PDF：鉴权下载合成 PDF 后创建 `application/pdf` Blob，iframe 原生 viewer 加载 1 页，隐藏窗口快照显示正文。IAB 中未显示 PDF 不能当作桌面 WebKit 失败的依据。
- 在 1280×800 长文中段，同一段阅读、编辑、保存后均为 Y=397.53125；源码取消和源码保存后也为同一 Y，正文 scrollTop=1956。
- 初次源码取消真实复现回到顶部；加入源模式位置记忆后，又发现同文段落匹配到第一段，分别修复并复验。不是仅靠不含真实子树的 stub 判绿。
- 390×844 下外层 scrollWidth=390，正文 scrollWidth=clientWidth=298，没有被 JSON 或媒体预览撑宽。
- 首页 Wiki 浅/深截图已更新，均用合成内容，尺寸 1526×954 与 HTML 声明一致。全站缓存统一为 `20261014-wiki-embed-previews`。

### 判据、审查与交付

- 后端新判据初次 12 项中 8 个真实 Failures；附件 owner 过滤和 Canvas 可选集合各有独立扰动失败。JDK 17 离线 clean 后相关 44 项全绿，无失败、错误或跳过。
- 前端真实发布 JS：嵌入/原文 16 项、安全/异步 13 项、编辑/草稿/滚动 10 项全绿；新增行为见过断言红。登录迟到响应、取消清草稿与历史栈均有独立扰动红；环境 Errors 没计作有效红灯。
- 原生快捷键 30 项结果断言通过，无超时；完整 arm64 macOS 13 外壳编译成功。只读审查发现的别名污染、带点标题、嵌入表格、目录误匹配、截断提示和重复段落问题均已修复。
- 第一次综合测试 1141 项，3 Failures / 0 Errors / 235 Skipped：旧静态判据仍定位取消的内联函数、保存参数，和“六级/四级”标题被旧产品文案判据误认作考试。已迁移判据至真实函数，格式菜单统一为“标题 1–6”。最终 JDK 17 离线 **clean 综合测试 1141 项：906 通过、0 Failures、0 Errors、235 明确跳过，BUILD SUCCESS**。
- 迁移后的取消按钮接线、取消历史栈选项各做一次单变量扰动，各为 12 项中的 1 个 Failure / 0 Errors；恢复后定向复验 29 项全绿。源码扰动保存在 `src/` 外并完整恢复，最终重新 clean。
- Docker 测试显式跳过；`DesktopLauncherTest` 会启动真实应用，本轮不运行；`HarnessCliNodeSuiteTest` 因上一轮已确认的 CLI slash-menu 基线失败单列，不把排除当作通过。
- macOS 重新打包完成：`build/desktop-native/知趣象限.app` 与 `build/desktop-native/知趣象限-1.0.0.dmg`（约 105 MiB）；应用签名与 DMG 校验通过。未启动、安装或替换用户现有应用，生成包为忽略文件，不进入 Git。
- 本轮源码、判据、截图和 round 记录一并提交，推送目标为已有 `claude/festive-ramanujan-37v8pa` 分支。合成服务与本轮浏览器页已关闭；真实模型调用 0 次、费用 ¥0。

最终综合命令（macOS，Swift/Clang module caches 使用本轮临时目录）：

```bash
cd zhiqu-backend
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
mvn -o clean test -Dtest='*,!DesktopLauncherTest,!HarnessCliNodeSuiteTest' -Dzhiqu.skipDockerTests=true
```
