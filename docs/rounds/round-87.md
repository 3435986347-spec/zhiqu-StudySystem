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
- 生成 10 题（10:12–10:40）、第一遍评分 9 题（django-15987 空补丁没进评分）；按上面的决定把补跑规则写进 run-config（6d929fc）再补跑 django-15987：15 轮完成。
  补跑那一遍的评分在官方 harness 准备阶段就挂了（去 raw.githubusercontent.com 取依赖清单，SSL EOF —— 同一段时间 git push 也碰到过），十题都没出报告；
  按协议「修好环境、同一份冻结补丁重评」：网络通了以后用同一份 predictions.jsonl（sha256 1c8fafac…）重评一次。

**结果：官方 6/10 resolved，十题完整性全过（`graded`）**（第六十九轮也是 6/10，但那次要两份配置拼起来、完整性 `integrity_unverified`）

| 题 | 第六十九轮：轮 / 输入 token / 官方 | 第八十七轮：轮 / 输入 token / 官方 | 说明 |
|---|---|---|---|
| django-12308 | 23 / 281,837 / 没解决 | 20 / 225,892 / **解决** | 新解决的一题 |
| django-15987 | 20 / 148,597 / **解决** | 15 / 101,020 / **解决** | 第一次网关那一侧失败（0 轮），补跑一次 |
| sympy-23950 | 60 用完 / 837,595 / **解决** | 60 用完 / 980,576 / **解决** | 还是用满 60 轮；原来 6 次静默删代码，这次 0 次，换成 16 次 `python3 -c` 试 |
| sympy-20154 | 18 / 148,316 / **解决** | 22 / 210,155 / **解决** | |
| pytest-10356 | 60 用完 / 921,056 / 没解决 | **33** / 555,240 / 没解决 | 待修测试 0/1 过、原来过的 79/79 照旧过；changelog `.rst` 直接写（原来约 10 轮绕 `.rst`） |
| pytest-5840 | 60 用完 / 1,254,681 / 没解决，**改坏 51 条** | **30** / 412,362 / 没解决，**51/51 照旧过** | 原来 13 次静默删代码，这次 0 次；修法不对（待修 0/2） |
| requests-1921 | 25 / 538,834 / **解决**（ID 1 补跑） | 22 / 426,498 / 没解决 | 待修 6/6 全过；挂的 2 条原来过的测试连 httpbin，`ProxyError` —— 受网络影响 |
| requests-1724 | 10 / 111,232 / 没解决（ID 1 补跑） | 20 / 219,068 / 没解决 | 待修 6/6 全过；挂的 1 条连 httpbin，`ProxyError` —— 受网络影响（第六十九轮也是这一类） |
| scikit-learn-10297 | 16 / 154,093 / **解决**（ID 1 补跑） | 10 / 171,394 / **解决** | |
| scikit-learn-13496 | 20 / 279,674 / **解决**（ID 1 补跑） | 11 / 150,999 / **解决** | |

- **合计**：轮数 312 → 243；用满 60 轮的题 3 → 1；输入 token 467.6 万 → 345.3 万（第六十九轮另有 ID 6 被预算打断的四题没算进去）；
  花费（同一个保守口径）¥47.69（ID 6 ¥37.66 跑到第七题停 + ID 1 ¥10.03 补四题）→ **¥33.13**（一份配置一遍跑完，含两次校准、失败的那一次预留、补跑 ¥0.98）。
- **第八十六、八十七轮改的东西在这次里的样子**：静默删代码 19 次 → 0 次（这次模型一次都没把替换后的字放进 `content`）；「新旧一样」1 次，照实说「什么都没改」；
  行内代码原来约 12 次被拒、每次多两轮 → 这次 38 次直接跑；`.rst` 直接读写；git 6 次都是「不是 git 仓库」（评测容器里本来就没有 `.git`，照计划不算它的分）。
  pytest-5840 有一次 `+0 -1` 是删一行用不着的 import，diff 摆在终端里，不是静默删。
- **分数为什么没涨**：新解决 django-12308，丢了 requests-1921 —— 后者待修的测试全过，挂的是连外网（httpbin）的老测试，和第六十九轮的 requests-1724 同一类；
  照开跑前的规则记「受网络影响」，网络修好以后用同一份冻结补丁重评，不在本机反复重评碰运气。没解决的两题（pytest 两题）都是修法不对，不再有工具把代码弄坏。
- 一题只跑一次，模型本身有随机性：单题的得失不说明问题，说明问题的是「用满轮数的少了、没有工具把代码弄坏、同样的钱跑完了全部」。
- 账本 `rerun-20261031.jsonl`（受理 246 次，全部有核实过的用量，只有失败的那一次按预留记）；逐题记录在 `<eval>/runs/rerun-20261031-*`，评分在 `<eval>/control/logs/run_evaluation/zhiqu-candidate-556e27e32524-1c8fafac7198-e6a930a5d9`。

## 真实模型验证（用户 2026-10-31：「验证真实测试，用那个apikey」）
用户在对话里给的 DeepSeek key 只配进验证库（`zhiqu_verify`，本机 18080）的测试账号 `r88real_aaa747`（模型 ID 23，deepseek-v4-pro，`https://api.deepseek.com`），只经过一次环境变量，没写进仓库、文件或用户平常那个库。
工作区：一个小的 Python 仓库（`calc.py` 的 `average` 传空列表报错、`test_calc.py`、`CHANGES.rst`），外加带毒的 `.gitconfig`（fsmonitor / 外部 diff / clean 过滤器）+ `.gitattributes`。
- 第一段（18 秒）：「修好空列表、补测试、跑测试、在 CHANGES.rst 加一行、看 git diff」—— 三处改动都是替换用法（`+2 -0`、`+3 -0`、`+1 -0`），`.rst` 直接写，unittest 3 条全过，`git diff` 照常出结果，没有叫起任何程序。
- 第二段（14 秒）：「一行 python 算 spread、看 git log / status、把改动 stash 起来」—— 第一次 `python3 -c` 忘了 import、看了报错自己改对（6）；git log / status 照常；`git stash` 被拒，
  它照实说只能跑只读的 git、没去绕，告诉用户自己在终端里 stash（要带上没跟踪的文件用 `-u`）；仓库原样（stash 列表空、改动还在），仍然没有叫起任何程序。
