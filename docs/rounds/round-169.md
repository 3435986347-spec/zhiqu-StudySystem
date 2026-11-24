# 第一百六十九轮（2026-11-24）：长活省钱第 4 步——shell 改了哪些文件看得见，用脚本改源码时提醒

[`docs/agent-efficiency-plan.md`](../agent-efficiency-plan.md) 的第 4 步（问题 D）。用户定的：**提醒，不拒绝**。

## 计划

用户那段会话里 shell 201 次有 158 次在写文件，127 次是 shell 里的 Python `s.replace(old, new)`：找不到原文时不报错、什么都不做（`edit_file` 当初要挡的静默失败，第八十六轮）；这些写入也不进「改过的文件」，先清的「读过之后又改过」看不到。

## 做了什么

- 新文件 `tools/shell-writes.js`：
  - `snapshot` / `diffSnapshots`：同步的 shell 命令前后各拍一次工作区的修改时间快照（最多 5000 个文件、300 毫秒，跳过 `.git` / `node_modules` / `.zhiqu` / 虚拟环境；超了返回 null，不比、不猜）。
  - `changeLine` / `writtenByShell`：工具结果里写一行「（这条命令改动了文件：修改 …；新建 …；删除 …）」，清理时从这一行认出 shell 写过的文件。
  - `inlineEdit` / `usesReplace`：认「在 shell 里用脚本改文件」（python / node / perl / ruby 的 `-c` / `-e` / heredoc 里打开文件写、`sed -i`、`perl -pi`、`cat >`/`>>` heredoc）；跑测试、跑脚本文件、只读命令、普通重定向不算。
  - `mentionedFiles` / `hashFiles` / `dropUnchanged`：**内容没变的不算改了**——真跑时撞到的：替换没对上时脚本照样 `open('a.js','w').write(s)` 把一样的内容写回去，修改时间变了，只看快照就当成「改了」，「一个文件都没改动」的提醒永远出不来。内联脚本改文件的命令，前后再给它提到的文件（认 `cd 目录 &&` 前缀）算内容哈希。
- `agent.js` `shellWriteNotes`：改动记进改过的文件（目标核对员、每轮的「改动的文件」都看得到）；内联脚本改了**已有**的文件时提醒改用 `apply_patch` / `edit_file`（第 1 次说，之后每 5 次说一次；新建文件、构建产物不提醒）；用字符串替换却一个文件都没改动，**每次**都说「原文多半没对上」。
- `compact.js`：`clearStale` 从 shell 结果里那一行认出它写过的文件（之前读过的那份标成「之后改过」）；清掉 shell 输出时占位里带着那一行。
- `tools/local.js`：shell 的工具说明加一句「改已有的源码用 apply_patch / edit_file，不要在这里用 python / sed / perl 替换字符串」。

## 结果

- 新判据 `test/shell-writes.test.js` 8 条（含一段真沙箱里的 Python 改文件；没有系统沙箱的机器显式跳过）。
- 8 处扰动各自见红：不比快照 → 1 红；不比内容（只看修改时间）→ 1 红；每次都提醒 → 1 红；不跳依赖目录 → 1 红；清理不认 shell 写的 → 1 红；占位不带那一行 → 1 红；不认 `cd` 前缀 → 2 红；不记改过的文件 → 2 红。
- 拿那段会话的 201 条 shell 命令量识别：认出 157 条，漏 1 条（`cat >> 文件 <<'EOF'` 追加写，补上后 158 条全认出，其中 140 条用替换）；没认出的 3 条是抓网页、写 `$TMPDIR`，不是改工作区。快照在用户的 `test` 目录（93 个文件）上 14 毫秒。
- CLI 全量：747 项，725 过 / 22 跳 / 0 失败。
- 真程序：假网关 + `bin/zhiqu.js -p … --mode auto`，模型两次用 shell 里的 Python 改 `src/a.js`：第一次真改了 → 结果里「修改 src/a.js」+ 提醒改用编辑工具；第二次替换没对上（原文已经不在了）→「一个文件都没改动，原文多半没对上」。HOME / ZHIQU_HOME 用临时目录，没调付费模型。（只动命令行，真浏览器暴力测试换成这段真沙箱 + 真程序测试。）
- 没发 npm、没部署：同第一百六十六轮。
