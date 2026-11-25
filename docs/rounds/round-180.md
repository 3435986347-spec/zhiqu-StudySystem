# 第一百八十轮（2026-11-26）：按文件名找文件的 glob

`docs/harness-next-plan.md` 第 5 步。`list_files` 只展开三层、最多 500 项。模型叫 `glob` 会被别名指去 `list_files`，找不到 `src/**/*Test.java` 这种深层文件。

## 计划

新增只返回路径的 `glob`（最多 200 个，多了就说这不是全部）。通配和 `.gitignore` 用 `search` 同一套。`node_modules` 这类目录照旧略过。plan 档也给。别名里拿掉 `glob` 这个名字；`ls` / `list_dir` 仍指 `list_files`。

## 结果

`test/glob.test.js` 两条：深层 `*Test.java` 找得到、gitignore 和 node_modules 不进、超过 200 个会截断。plan 档的工具表和草稿层的允许清单跟着加上 `glob`。
