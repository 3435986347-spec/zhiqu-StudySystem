# 第八十六轮（2026-10-31）：coding agent zhiqu —— 评测里没过的题各是为什么，先修工具让模型看错、做错的地方

## 由来
用户 2026-10-30：「同时除此之外还要继续优化coding agent zhiqu，为什么跑测试有那么多没有过，还有哪里可以提高。」排在 Wiki（第八十三到八十五轮）之后；
用户 2026-10-31：「做完后review，review不出问题后接着做下一轮的zhiqu coding agent」。

## 摸底：没过的题各是为什么（读第六十、六十九轮的逐题记录 `/Users/hmz/zhiqu-repo-eval/runs/*/<题>/final/.zhiqu/sessions/*.jsonl`）

**仓库评测（SWE-bench Verified 固定十题，官方 6/10）**
- **pytest-5840（60 轮用完、没解决、另把 51 条原来过的测试改坏）—— 是工具删了代码**：模型 13 次调 `write_file` 时给了 `old_string` + `content`（把替换后的文字放进了 `content`，没给 `new_string`）。
  工具只看 `old_string` 在不在，就按替换处理，`new_string` 缺了当成空字符串 —— **一声不响把那段删掉**，回「✓ 已修改（+0 -32）」。
  模型看到「+0 -32」以为是显示问题，接着「改」，每次又删一段；后来建 `scratch_test.txt` 做实验（把 line2 换成别的字，结果变成空行）想弄清工具怎么回事，60 轮就这么用完了。
  开头 3 次 `new_string` 和 `old_string` 一模一样，工具也回「已修改（+0 -0）」，模型以为改上了。
- **sympy-23950（60 轮用完、官方算解决）**：同一个错，6 次 `old_string` 没带 `new_string`。
- 命令行（`zhiqu-cli/src/tools/edit.js` 的 `applyEdit`）和网页 code agent（`TextEdit.java`，`CodeWorkspaceAgent` 把缺的 `new_string` 换成 `""`）是同一套规矩、同一个错。
- **pytest-10356（60 轮用完、没解决）**：约 10 轮花在 `.rst` 上 —— `.rst` 不在扩展名白名单里（Python 项目的 README、changelog 都是它），列目录时标成「这类文件读不了：可能含密钥」；
  读 changelog 被拒、写 changelog 被拒、`python3 -c` 读被拒两次、写辅助脚本去读、再写一个脚本去写 `.rst`、再删三个临时文件。用 python 一样写得进去 —— 这道关什么都没拦住，只花轮数。
- 其余：django-12308 改错了（模型的事）；requests-1724 是评分环境连 httpbin 回 502（第六十九轮记过）。
- 各题都碰到：`git` 不在允许清单（4 次）、`python3 -c` 被拒（12 次，每次多花「写文件 → 跑 → 删」两轮）—— 这两条是安全边界（只能运行用户看过的文件），**不在这一轮改**，要不要放开 `git` 的只读子命令留给用户定。

**HumanEval（156/164）**：8 题里 6 题「开头的空行没了」第六十九轮已修（`read_file` 让模型看不见开头的空行）；/132 20 轮用完、/120 /125 答错（模型的事）。

## 计划
1. **替换缺 `new_string` 不再当成「删掉」**：`old_string` 有、`new_string` 没给 → 拒绝，说清「换成什么要放 new_string；content 只用于整份写入 / 追加；真要删掉这段就明写 new_string: \"\"」。
   `old_string` 和 `content` 一起给也拒（分不清要整份写还是替换）。命令行和网页 code agent 一起改，用例进两边都跑的 `conformance/text-edit.json`。
2. **新旧一样不再说「已修改」**：`new_string` 和 `old_string` 一模一样 → 拒绝，说「这次什么都没改」。
3. **`.rst` 这类常见的源码 / 文档文件能读能改**（命令行自己的清单）：加 rst、pyi、pyx、pxd、in、tex、adoc、proto、graphql、tsv、cmake；
   列目录时读不了的写「这个类型不在能读的清单里」，不再说「可能含密钥」；拒绝时说清可以在 `.zhiqu` 的配置里加 `extensions`。
4. 判据先红；拿评测的真实记录回放：十四段会话里的每一次 `write_file` 原样喂给新的工具，看原来静默删代码的那些现在是不是都拒了、拒的话说没说清。
5. 命令行全量（Node 22）、后端全量（Docker）；真实进程里跑一遍（假模型发出 pytest-5840 那种参数，看终端里说什么）。
6. 不花钱的到此为止；要不要用同样十题重跑一次看分数（要花模型费）留给用户定。

## 结果
**改了什么**
1. `write_file` 替换用法：没给 `new_string`（缺或 null）→ 拒绝（`missing_new`）；新旧一模一样 → 拒绝（`no_change`，在「没找到」之后判：原文里根本没有时先说没找到）；
   `old_string` 和 `content` 一起给 → 拒绝（`with_content`，工具那一层判）。真要删一段得明写 `new_string: ""`（原来的用例照旧）。
   命令行（`edit.js` / `local.js`）和网页 code agent（`TextEdit.java` / `CodeWorkspaceAgent`）同一套、说法一样；两边的工具说明加一句「换成的文字放 new_string，不要放 content；要删一段给 new_string=""」。
2. 扩展名：加 rst、pyi、pyx、pxd、in、tex、adoc、proto、graphql、tsv、cmake —— 命令行和服务端（`WorkspaceProperties`，`WorkspaceExtensionsTest` 钉着两边一份）一起加；
   列目录时读不了的写「不在能读的清单里」（`.rst` 原来也标「可能含密钥」）；拒绝时说清可以在 `.zhiqu/settings.json` 的 `extensions` 里列上（这一项整个替换默认清单）、不要写脚本绕过去。
3. 评测工具：冻结的 pilot 配置钉着第六十九轮评测的那一版 agent，agent 一改它照设计拒跑 —— 原来两条测 Docker / 网关的判据顺带要求 agent 一个字没改过，这一轮一改就红。
   给 `preflight` 加读配置的注入口（和 `runDocker` / `api` 一样），那两条读配置时不核 agent；另加一条判据钉住「agent 改了，冻结的配置拒跑」。pilot 配置本身没动（它是第六十九轮那次的记录）。

**拿评测的真实记录回放**（14 段会话从各题的基线仓库开始，83 次 `write_file` 原样喂给新工具；`run_command` 不回放）
- 原来回「已修改」、实际一声不响删了代码的 19 次（pytest-5840 13 次、sympy-23950 6 次）现在全拒，说的是「old_string 和 content 不能一起给」（一共 20 次，另一次是三项全给）；
- 原来「已修改 +0 -0」的 3 次现在说「什么都没改」；原来被拒的 2 次 `.rst` 读写现在能做。

**真实进程**（`zhiqu_verify` 里的测试账号 `r86cli_55945f`，模型指到本机假模型 `mock-model.cjs`，`zhiqu -p … --mode auto`）
- 同一份脚本「先 old_string + content、再用对的参数」：新命令行第一下拒、终端和模型收到同一句话，第二下改上，`def b()` 原样；
  **对照**：改之前的命令行（HEAD 的 archive）第一下「✓ 已修改 m.py +0 -2」把 `def a()` 整个删了，第二下「没找到」，最后还说「改好了」—— 和 pytest-5840 一模一样，缩小成一个文件。
- 再过一组怪参数（`new_string: null`、`replace_all` 新旧一样、`content: ""` + `old_string`、新建 `.rst`、写 `.pem`）：都照实拒或照做，`m.py` 一字未动。

**判据**：`conformance/text-edit.json` 加 5 条（两边都跑；Java 那边原来把没有的 `new` 读成 `""`，正好是这个错）、`local-tools.test.js` 加 2 条、`CodeWorkspaceAgentTest` 加 1 条、`run-repository.test.mjs` 加 1 条。
扰动 12 处全红（第一遍「old_string + content 照替换」两边都绿：缺 `new_string` 那道替它挡了，补了三项全给的样本才红）。
命令行全量 259/259（Node 22）；评测工具 75 过、1 条显式跳过（第六十九轮记过的 HumanEval 沙箱）。
后端全量第一遍红两条：`ClaudeMdTest`（这一行还没加）、`WorkspaceExtensionsTest`（服务端的清单要和命令行一样 —— guard.js 里「以下几种服务器端没有」那句第八十一轮起就不对了，一起改了）。
后端全量第二遍（`mvn -o clean test`，Docker 开着）：1322 条，0 失败、0 跳过。

**没做、要用户定的**
- 要不要用同样十题再跑一次看分数（要花模型费，第六十九轮两次合计 ¥47.69）：新跑要另写一份 run-config 钉这一版 agent，第六十九轮那份留作记录。
- `git` 的只读子命令（diff / log / status）放不放进默认允许清单：评测里被拒 4 次，但 git 会按仓库里的配置执行别的程序，是安全边界。
- `python3 -c` 的拒绝不改：只能运行用户看过的文件是代码工作区唯一真正的安全判定（CLAUDE.md）；代价是每次多两轮（写文件 → 跑 → 删）。
- HumanEval 剩下的：/120、/125 答错，/132 20 轮用完 —— 都是模型那一侧；/132 的逐轮记录在公司电脑上，这台机器没有。
