# 第一百六十五轮：首页加 zhiqu code 的宣传区（仿 Claude Code）

## 计划
用户要求（2026-11-23）：在主页增加 zhiqu code（命令行 coding agent，npm 包 `zhiqu`）的宣传，仿照 Claude Code 的落地页；加一个「获取 zhiqu code」，就是 npm 安装。

## 做了什么
- `index.html`：功能卡片下面加 `#zhiqu-code` 一块 —— 左边一句话 + 说明 + 安装命令 `npm install -g zhiqu`（点「复制」写进剪贴板，没有剪贴板接口时选中文字）+ 三步（安装 / `zhiqu login` / `cd 你的项目 && zhiqu`）+ npm 与 npmmirror 链接；右边一块一直是深色的终端示例；底下四条特点（跑在本机、系统沙箱、exec 与 review、直连自己的模型），说法都照 `zhiqu-cli/README.md`。
- 首屏按钮多一个「获取 zhiqu code」，跳到这一块。
- 样式都在页内 `<style>`，字号用 `--zq-fs-*`、字重用 `--zq-fw-*`，没有内联样式；手机上一列，≤400 宽时复制按钮只留图标（文字给读屏）。
- `HomeCarouselTest`：图标占位 6 → 12。缓存令牌 `20261123-r165`。

## 结果
- 相关判据 59/59（落地页、图标、字重、内联样式、缓存令牌、定位用语、CLAUDE.md 行数等）。
- 真 Chrome（Playwright）量过 320 / 360 / 390 / 768 / 1280：都没有横向滚动，安装命令不截断；锚点跳转、点「复制」变「已复制」都对；浅色、深色截图看过。
- 没有部署到服务器（网页改动部署后才到用户手里）。
