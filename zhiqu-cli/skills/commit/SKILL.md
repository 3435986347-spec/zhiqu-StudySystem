---
name: commit
description: 把当前改动整理成提交：按意图分组、写清为什么，产出给用户执行的 git 命令（这个环境不能写 .git）
---

# 整理提交

## 前提：这里不能自己提交

`shell` 跑在系统沙箱里，**写不了 `.git`**：

```
$ git add a.txt
fatal: Unable to create '…/.git/index.lock': Operation not permitted
```

`git add`、`git commit`、`git checkout` 都是这个结果。`run_command` 的 git 也只放 `status` / `diff` / `log`。

看到 `Operation not permitted` 要知道这是**沙箱边界**，不是文件权限没设对 —— 不要试 `chmod`、`sudo`、换目录、写 `.git/index` 绕过，那些只会白花几轮。

所以你的产出是**给用户执行的命令和提交说明**，不是真的提交。做完说清这一点，不要让用户以为已经提交了。

## 1. 先看清有什么

```
git status
git diff
git diff --staged
```

`git status` 报 `not a git repository` 就直说「这个目录还不是 git 仓库」，然后问用户要不要 `git init` —— 不要自己建。

`git status` 里出现这些，先停下问用户，不要自作主张提交：

- `.env`、`*.pem`、`id_rsa`、`credentials*`、`*.p12`、带 token 的配置文件
- 构建产物和依赖目录：`target/`、`dist/`、`node_modules/`、`*.class`、`*.log`
- 大文件、二进制、数据库文件
- 和这次任务无关的改动（可能是别人正在改的文件）

已经提交进历史的密钥，删掉文件不算解决 —— 要提醒用户轮换密钥。

## 2. 按意图分组

一个提交 = 一个「为什么改」。判断标准：如果这个提交被单独回滚，项目还是自洽的吗？

- 修 bug 的改动 + 它的回归测试 → 同一个提交。
- 重构 + 功能 → 分开。
- 格式化 + 逻辑 → 分开（除非格式化就是这次的目的）。
- 三个不相关的顺手修复 → 三个提交，或者只提交和任务相关的那一个。

## 3. 写 message

```
<类型>: <做了什么，50 字以内，祈使句，句尾不加句号>

<为什么：原来的问题是什么、为什么这样改。每行 72 字以内。>
```

类型用项目已有的：先 `git log --oneline -20` 看一眼邻居怎么写的，跟着来。没有约定时用 `feat` / `fix` / `refactor` / `test` / `docs` / `chore` / `perf`。

不要写「更新代码」「修复问题」「按需求修改」—— 等于没写。要写清改之前是什么行为、改之后是什么行为。

## 4. 交给用户

按分组给出可以直接粘贴的命令：

```bash
git add src/a.js src/a.test.js
git commit -m "fix: 空标题的任务不再写入日历" -m "标题为空时前端仍然提交，后端直接落库。改为在 service 层校验并返回 400。"
```

多个提交就按顺序列出来。最后提醒一句：`git push` 之前自己再看一眼 `git status`。
