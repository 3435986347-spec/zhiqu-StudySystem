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
   这台机器上试过（git 2.50）：`git status` 叫起 fsmonitor，`git diff` 叫起 clean 过滤器和外部 diff。跑 git 时 `GIT_CONFIG_GLOBAL` 指到空设备（计划时还写了 `GIT_CONFIG_NOSYSTEM=1`，系统配置不是仓库能带进来的、判据也照不出它，没留）、
   `--no-pager`、`-c core.fsmonitor=false`、`-c log.showSignature=false`，diff / log 加 `--no-ext-diff --no-textconv`；只给参数不隔离环境时 clean 过滤器照样跑（这条是判据的对照）。
3. 提示词里那句「不接受 -c / -e / --eval 这类行内代码」改掉，说清 git 只能 status / diff / log。
4. 判据：规则（放开的、照旧拒的）、真的 git 仓库里放带毒的 `.gitconfig` + `.gitattributes`，三个子命令跑完没有叫起任何程序、输出照常；扰动见红。命令行全量。
5. 重跑：另写一份 run-config（`docs/benchmarks/repository-rerun-20261031/`）钉这一版 agent，第六十九轮那份留作记录；同样十题、同一模型 ID 6、同样的隔离和官方评分，上限 ¥100、新的账本前缀；
   评测环境不动（生成容器里照旧没有 `.git` —— git 在评测里只会说「不是 git 仓库」，放开它是为了真实使用；保持和第六十九轮可比）。
   编排器读哪份配置、额度上限、账本前缀、run 前缀从配置来（原来写死第六十九轮那份）。先跑不花钱的（runtime、smoke），再校准、开跑、评分。
6. 网关：评测要用户真实账号里的 ID 6，桌面应用要连它平常的库启动（第六十九轮也是这样）；验证库里的那份停掉。

## 结果（一）：命令行（518ee5c）
- `execrules.js`：`checkCommand` 加 `inlineCode` 选项（默认不放，服务器端和一致性用例走默认）；命令行那一层 `checkLocalCommand` 放开行内代码、git 只认 status / diff / log，
  拒的时候说清（「只能跑 git 的 status / diff / log（只读；第一个参数就是子命令…）」「git 不接受这个参数：--output（会写文件或者叫起别的程序）」）。默认清单 `LOCAL_DEFAULT_COMMANDS` 多一个 git。
- 真正跑 git（`gitLaunch`）：`GIT_CONFIG_GLOBAL` 指到空设备、`GIT_OPTIONAL_LOCKS=0`；`--no-pager -c core.fsmonitor=false -c log.showSignature=false -c color.ui=never`，diff / log 加 `--no-ext-diff --no-textconv`。
  终端里摆的是模型给的那条命令，加的参数不显示。`runProcess` 多一个 `env`（加在最小环境上，不是替换）。
- 提示词：「一两行的小检查直接用 python3 -c / node -e 跑（整条命令用户看得见），长的、要留下的写成文件；git 只能跑 status / diff / log（只读）」。
- 这台机器上先试的（git 2.50）：仓库里带一个 `.gitconfig`（HOME 是工作区）+ `.gitattributes`，**不隔离**时 `git status` 叫起 fsmonitor、`git diff` 叫起 clean 过滤器 + 外部 diff + fsmonitor；
  只加参数不隔离环境，clean 过滤器照样跑；参数 + 环境都上，什么都没叫起。git 不认 `--ext` 这种缩写（退出码 129），参数精确比对就够。
- 判据：`local-tools.test.js` 两条 —— 规则（放开的、照旧拒的 14 种、`--output-indicator-new` 是正经参数、npm exec 照旧拒）；
  真的 git 仓库：带毒的 `.gitconfig`（fsmonitor / pager / 外部 diff / clean 过滤器）、仓库自己 `.git/config` 里的 fsmonitor / 外部 diff / textconv、假签名的提交 + `log.showSignature` + `gpg.program`，
  三个子命令跑完一个都没叫起、输出照常，`git status` 不重写 `.git/index`。扰动 12 处全红
  （第一遍「status 顺手写 index」绿：样本里那个文件内容改了，index 本来就不用刷新；换成「内容没变、时间变了」的文件才红。另外查到 `git diff` 自己会刷新 index 里的时间戳、不认 `GIT_OPTIONAL_LOCKS`，那是 git 的老规矩，判据只管 status）。
- 真实进程（`zhiqu_verify` 的测试账号 `r87cli_4cb9ce`，假模型，`zhiqu -p … --mode auto`，同一个带毒的仓库）：`python3 -c` 跑出 42、`git status --short` / `git diff` 照常、`git stash` 拒、没有叫起任何程序；
  **对照**：改之前的命令行 `python3 -c` 和 git 全拒；同一个仓库里直接 `HOME=工作区 git diff`，clean 过滤器、外部 diff、fsmonitor 全被叫起 —— 不加这层就放开 git，等于开了一个口子。
- 评测编排：`repository-docker.mjs` 加 `--config`；run-config 有 `rerun` 一节就用它的 run 前缀和账本前缀、额度照它的 budget（≤ ¥100，token 上限按价算不超过钱数）；不拿第六十九轮的补；
  broker 的上限从 ¥50 到 ¥100（用户定的）；preflight 认 rerun 的 ¥100、pilot 照旧 ¥50。判据 5 条、扰动 7 处全红。
- 改了原来两条判据：评测 worker「git 一律拒」改成「写的子命令不跑就拒」（发布的默认现在有只读 git）；「冻结的配置拒绝改过的 agent」原来靠别的几个指纹恰好对得上，改成先把其余几个对上现在的文件。
- 命令行 261/261；评测工具 79 过、1 显式跳过；后端全量 1322 条，只红 `ClaudeMdTest`（这一轮的那一行还没加，加上再跑过）。

## 结果（二）：重跑十题
- run-config：`docs/benchmarks/repository-rerun-20261031/run-config.json`（agent 钉 518ee5c、CLI 树 254688a，broker 换了指纹，worker / collector 没变；模型 ID 6，上限 ¥100 / 800 万输入 / 100 万输出；同样的镜像、隔离、限额、官方评分）。
- 桌面应用连它平常的库启动当网关（ID 6「deepseek测试专用（我的）」deepseek-v4-pro / 1M 看得到）；验证库那一份停了。
- preflight：网关、模型、Docker 都对；唯一的 blocker `docker_controls_not_verified` 和第六十九轮一样（gold 有两题因为本机网络过不了，按题的例外写在 `controls_exceptions` 里，正式开跑的门按题判）。
- runtime 按 518ee5c 重摆（Node 24.19.0、worker / broker 指纹对上）。
- 不花钱的对照重跑：smoke 10/10（每题单题网络、只通 broker、真的 LocalTools 读写 base、跑一条公开测试；网络策略指纹和第六十九轮一样）、lifecycle 通过（取消前 7 个进程、停掉后 0，账本收 1 拒 1、能力撤销）。
- 开跑（2026-10-31 10:12 起）：校准过（ID 6 / deepseek-v4-pro / 1M）。第 2 题 django-15987 第一个请求在网关那一侧失败（broker 记 `upstream_error`，0.5 秒，0 轮、模型一个字都没回），这一题空补丁。
  桌面后端不写日志文件，看不到网关回了什么；网关给 harness 的限流是每分钟 60 次、broker 至少隔 1.2 秒发一次，不是限流。后面的题照常在跑。
  **决定（在这一次评分之前）**：这一题按基础设施故障单独补跑一次 —— 只认「0 轮、没有任何模型输出」的 `gateway_error`；规则在补跑的调用之前写进 run-config，两次记录都留。
