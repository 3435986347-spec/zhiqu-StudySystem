# 第一百五十九轮（2026-11-20）：Windows 下载说明与原生外壳一致

用户指出 Mac 和 Windows 桌面版现在都直接连接服务器，要求修正网页「下载桌面版」里的 Windows 描述，部署并提交。

## 计划

- Windows 描述改为打开同一个网站、同一账号同一份数据、断网时看不了，删除自带后端与 MySQL 配置说明。
- 更新下载弹窗专项判据；先确认新判据能拦住旧文案。
- 静态缓存令牌从 `20261117-r153` 升到 `20261120-r159`，所有 HTML 与 Service Worker 同步。
- 跑专项测试和缓存令牌检查，部署到 `zhiqustudy.com`，核对线上文案后只提交本轮文件。

## 实现

- Windows 说明改为「打开的也是这个网站：用同一个账号登录，就是同一份数据；断网时看不了。」，不再出现 MySQL 或 `.zhiqu/application.yml`。
- 15 个 HTML 页面和 `service-worker.js` 的缓存令牌统一为 `20261120-r159`。
- 下载弹窗判据同时检查 Windows 的新说明和旧 MySQL 说明已移除。

## 验证

- 新判据先在旧实现上运行：`DesktopDownloadTest` 为 Failures 1 / Errors 0，明确报「写清 Windows 版也打开网站，不再要求 MySQL」不通过。
- 修改后运行 `mvn -o test -Dtest=DesktopDownloadTest,StaticAssetCacheTokenTest`：Tests run 8，Failures 0，Errors 0，Skipped 0。
- 最终合并运行 `DesktopDownloadTest`、`StaticAssetCacheTokenTest`、`ClaudeMdTest`：Tests run 13，Failures 0，Errors 0，Skipped 0。
- `deploy-from-dev.sh` 退出码 0；生产后端 `systemctl is-active zhiqu-backend` 返回 `active`。线上实际返回 Windows 新文案与缓存令牌 `20261120-r159`，旧 MySQL 和 `.zhiqu/application.yml` 说明均未出现。
