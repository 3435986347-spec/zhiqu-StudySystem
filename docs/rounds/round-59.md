# 第五十九轮（2026-10-13）：模型配置允许内网地址

## 由来

用户要求：「把里面的模型配置在生产环境不允许指向内网给去掉」。
现有模型请求共用 `ModelProviderClient.validateProviderRequestUrl`，默认拒绝本机和内网地址，
并在 DNS 无法解析时提前拒绝；本地假模型要额外开 `app.ai.allow-private-provider-url`。
本轮按用户要求取消这套地址范围限制，网页和命令行共用的新行为在所有环境生效。
第五十八轮提到的界面打磨第 8 步余项继续留待下一轮。

## 计划

- 模型地址仍要求合法 URI、HTTP / HTTPS 协议和主机；删除私网 IP、回环、内部域名和 DNS 解析的提前拦截。
- 移除模型私网开关及调用方构造器里的透传；保留真正发请求之前的 URL 格式校验。
- 调整模型请求行为判据，让默认配置直接请求本机假模型，并覆盖内网 / 内部域名、无效 URL；先确认新断言在旧限制下因断言失败而变红。
- 更新启动说明和模型策略说明，保留旧修复历史。网页抓取仍保留独立的 SSRF 防护。
- public 构造器签名改变后跑 `clean test`，照实记录环境失败和跳过项。

## 真浏览器暴力测试计划

在隔离的 HTTP 验证服务与本机假模型上，通过真实网页设置保存内网模型配置、测试连通，再连点测试与刷新设置，
确认没有旧的「生产环境禁止」提示、配置不丢失；也验证坏协议仍显示格式错误。
HTTP 验证服务使用真实的 `saveModel` 和内存 mapper 替身，不连接数据库。
验证不启动桌面应用，不操作用户真实数据。

## 结果

- 修改前全量基线：1040 条、2 条 Failures、0 条 Errors、235 条 Docker 测试跳过；失败在 Node 判据，报告缺少 TAP，并照出已有的斜杠菜单行为失败。
- 修改前模型相关基线：26 / 0 / 0 / 0。
- 新行为判据先在旧实现跑红：39 条中 15 条 Failures、0 条 Errors，保存路径 2 条、命令行模型网关 1 条、URL 校验 12 条，断言都执行到了。
- 删除限制后，6 个类合计 50 / 0 / 0 / 0；其中网页抓取 SSRF 的 7 条照样通过。
- 注释与文档收口后，相关测试加 `ClaudeMdTest`、`ProdConfigParityTest`、`SourceTreeCleanlinessTest` 合计 57 / 0 / 0 / 0；差异格式检查通过。
- `AiModelPrivateUrlTest` 验证私网模型保存及 Ollama 默认本机地址；`ModelProviderUrlValidationTest` 覆盖本机、私网 IPv4 / IPv6、内部域名和 prod profile，无需私网开关。
- 出站前格式校验的源码判据改名为 `ModelProviderUrlValidationOrderTest`；网页与命令行依然在真正请求前校验地址格式。
- 临时移除 URL 格式校验后，22 条中 10 条 Failures、0 条 Errors；坏协议、缺少主机和无效 URI 的断言变红，原源码已恢复。
- 修改后用 JDK 17、bundled Node 24 跑 `mvn -o clean test`，并以 `-Dzhiqu.skipDockerTests=true` 显式跳过 Docker 测试：1064 条、2 条 Failures、0 条 Errors、235 条 Skipped。
  两条失败方法与基线相同：`HarnessCliNodeSuiteTest.全部通过`（缺少 TAP，底下还有已有的斜杠菜单行为失败）和
  `NodeRunnerTest.被取消的测试要点名`（缺少 TAP）。本轮相关判据通过，但全量不能记成全绿。

## 真浏览器实测

通过 CUA 的内置浏览器加载仓库中的真实网页，在临时 HTTP 验证服务上走设置弹窗：

- 保存指向 `10.24.8.6` 的模型配置，成功补齐 `/v1/chat/completions`，界面显示保存后的私网地址。
- Ollama 留空 URL / Key，成功保存默认的 `localhost` 地址。
- 保存本机假模型并点击「测试连通」，显示「通过」；再连续点击 5 次，刷新后 3 份配置仍在。
  最终 `/verify/state` 确认本机模型为 `VERIFIED`，共 3 行配置，实际发送 6 次假模型 HTTP 请求。
- 尝试保存 `ftp` 地址，没有增加模型配置；整个过程没有旧的「生产环境禁止」提示。

临时服务使用真实的 `saveModel` / 列表 / 测试服务和内存 mapper 替身，模型测试实际请求本机 HTTP 假模型；
没有连接数据库，也没有经过 Spring 登录与鉴权中间件，因此这段实测覆盖网页到模型服务的行为，数据库和完整登录链路未覆盖。
没有启动桌面应用或操作用户真实数据。CUA 的截图确认私网地址已显示；未保存截图文件。
验证结束后停止临时服务。
