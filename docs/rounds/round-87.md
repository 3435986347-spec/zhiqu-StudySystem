# 第八十七轮（2026-10-31）：命令行放开行内代码和 git 的只读子命令，用新 agent 重跑仓库评测十题

## 由来
第八十六轮收口时留给用户定的三件，用户 2026-10-31：
- 「先真实桌面review，再重跑，用测试deepseek api」—— 桌面 review 已补完（第八十五轮末尾、e0d7d2a）；重跑十题用 ID 6「deepseek测试专用」；
- 「还有第二、第三点也都能用」—— `git` 的只读子命令（diff / log / status）进默认允许的命令、`python3 -c` 不再拒；
- 预算：「上限提到 ¥100」（照第六十九轮的保守记账：输入全按未命中价，实际扣费远低于这个数）。

## 范围
- 只改**命令行**（`zhiqu-cli`，跑在用户自己的电脑上，跑之前整条命令连同行内代码都摆在终端里：ask 档逐条问，auto 档照样打出来）。
  服务器端的代码工作区照旧：「只能运行用户看过的文件」是那边唯一真正的安全判定（CLAUDE.md），一致性用例 `conformance/workspace-rules.json` 管的那份规则不动。
- git 只放 status / diff / log（用户说的三个；`show`、`stash` 这些不加）。

## 计划
1. 命令规则：`execrules.js` 加命令行自己的一层（`checkLocalCommand`）—— 行内代码（`-c` / `-e` / `--eval` …）放开；`git` 的第一个参数必须是 status / diff / log（子命令前面的全局参数 `-c`、`-C`、`--git-dir` 一律不认），
   `--output`（写文件）、`--ext-diff`、`--textconv`、`--show-signature`（叫别的程序）不认；绝对路径、`..` 照旧拒。
2. git 真正跑的时候再关一层：子进程的 HOME 是工作区，克隆下来的仓库里带一个 `.gitconfig` 就会被当成全局配置读 ——
   这台机器上试过（git 2.50）：`git status` 叫起 fsmonitor，`git diff` 叫起 clean 过滤器和外部 diff。跑 git 时 `GIT_CONFIG_GLOBAL` 指到空设备、`GIT_CONFIG_NOSYSTEM=1`、
   `--no-pager`、`-c core.fsmonitor=false`、`-c log.showSignature=false`，diff / log 加 `--no-ext-diff --no-textconv`；只给参数不隔离环境时 clean 过滤器照样跑（这条是判据的对照）。
3. 提示词里那句「不接受 -c / -e / --eval 这类行内代码」改掉，说清 git 只能 status / diff / log。
4. 判据：规则（放开的、照旧拒的）、真的 git 仓库里放带毒的 `.gitconfig` + `.gitattributes`，三个子命令跑完没有叫起任何程序、输出照常；扰动见红。命令行全量。
5. 重跑：另写一份 run-config（`docs/benchmarks/repository-rerun-20261031/`）钉这一版 agent，第六十九轮那份留作记录；同样十题、同一模型 ID 6、同样的隔离和官方评分，上限 ¥100、新的账本前缀；
   评测环境不动（生成容器里照旧没有 `.git` —— git 在评测里只会说「不是 git 仓库」，放开它是为了真实使用；保持和第六十九轮可比）。
   编排器读哪份配置、额度上限、账本前缀、run 前缀从配置来（原来写死第六十九轮那份）。先跑不花钱的（runtime、smoke），再校准、开跑、评分。
6. 网关：评测要用户真实账号里的 ID 6，桌面应用要连它平常的库启动（第六十九轮也是这样）；验证库里的那份停掉。
