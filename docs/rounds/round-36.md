# 第三十六轮（2026-10-05）：知识 Wiki 拆成模块（方案第 4 步的第七块）

## 由来
方案第 4 步接着一页一页搬，剩知识 Wiki 和 AI 助手两页，都大。这一轮搬 Wiki（壳里约 1000 行：目录树、正文、编辑、草稿、标签页、
导入来源、体检、关系图、待合入变更）。

## 计划（开工时）

1. **挪**：`WIKI_TYPE_MAP` … `flattenKnowledge` 进 `pages/knowledge-wiki.js`，代码一个字不改。
   **留在壳里的**：Markdown 渲染那一套（`renderMarkdown`、代码块着色、公式、`htmlToMarkdown`）—— AI 助手也用，经 `zqShared` 给。
   壳里的 Wiki 函数除了 `boots` 表那一处没有别的地方调（挪之前用脚本数过），`state.wiki*` 也只有 Wiki 自己读写。
2. **先查判据**：`DraftsTest`（Wiki 没保存的改动）、`KnowledgeSourceTruncationTest`（导入截断要说出来）、`MainFlowWalkthroughTest`（待合入变更能合入 / 忽略）、
   `WikiTabsTest` 和 `wiki-tabs-check.js`。
   **`wiki-tabs-check.js` 这一轮不改成 import**：它要把 `paintWikiDoc` 换成替身，只跑标签页的状态机（真的 `paintWikiDoc` 要画整页）——
   模块里的函数之间互相调用，从外面换不掉。它改成从模块文件里抠同一段（照旧会核对抠出来的片段里真有那几个函数）。
3. **暴力测试**：真浏览器里开页、切页、新标签页、编辑 → 不保存刷新（草稿恢复）、保存、导入来源（长文截断要说）、体检、关系图、待合入变更。

### 怎么验
真浏览器走一遍；全量通过、扰动见红；桌面应用重新打包。

## 结果（2026-10-05）

照计划做完。

- **挪**：知识 Wiki 进 `pages/knowledge-wiki.js`（954 行），壳 4905 → 3968 行，代码一个字没改。`zqShared` 补上 `API`、`token`、`popMenu`、`drafts`、
  Markdown 那一套（`renderMarkdown`、`renderMathIn`、`mathBlockHtml`、`htmlToMarkdown`）。挪之前用脚本数过：壳里除了 `boots` 表没有别处调 Wiki 的函数，
  `state.wiki*` 也只有 Wiki 自己读写；壳是 `'use strict'` 的、Wiki 这段没有往 `window` 上挂东西、页面里没有内联的 `onclick` —— 挪进模块（总是严格模式）不会变样。
- `wiki-tabs-check.js` 照计划没改成 import，改成从模块文件里抠同一段（结尾换成顶格的 `function wireWikiTabShortcuts()`）；扰动 V8（同一页再打开也压历史）它照样红。
- 跟着改的判据：`DraftsTest.Wiki接线`、`KnowledgeSourceTruncationTest`、`MainFlowWalkthroughTest.待合入变更`、`WikiTabsTest`（四条读模块）。

**真浏览器**（`zhiqu_verify`）：打开 → 正文（表格照常渲染）；目录树点另一页、⌘+点目录项开第二个标签；「+」开的是快速切换（挪之前就是这样）；
健康检查（未发现问题）、图谱（6 页 10 条链接）、待合入变更（暂无）；**编辑了不保存就刷新** → 回到同一页、顶上一条「恢复 / 丢弃」，丢弃之后草稿没了、正文没变；
**导入超长来源**（2.5 万字）→「来源已导入（原文 25000 字，只保存了前 20000 字）」；新建知识页（目录变成 7 页）；编辑 → 保存 → 库里存上了（存进的是当时开着的那一页，不是新建的那页 —— 见下）。控制台没有报错。
加载的是 `pages/knowledge-wiki.js?v=20261005-wiki`。

**走的时候踩到、和这次挪动无关的两件（没改，记下来）**：
- 新建知识页之后 Wiki 不打开新的那一页，还停在原来那个标签上（`createWikiPage` 建完调的是 `bootKnowledge`，它按存着的标签页恢复）—— 于是「新建完接着点正文写」写进的是原来那一页。
  这次就是这样把一行验证文字存进了种子数据里的「用户访谈结论（9 月）」，已经用接口改回原文；验证页删了。
- 所见即所得编辑保存时，有序列表 `1. 2. 3.` 存回去成了 `1. 1. 1.`（`htmlToMarkdown`，在壳里没动过）。渲染出来一样，但源码变了样。
两条导入的长来源留在 `zhiqu_verify` 里由用户删。

**第一遍全量红了 1 条**：`TaskFormTest.文件输入框的标签` 用**正则**在壳里找「带标签的 file input」—— 唯一那一个（Wiki 导入来源）挪进了模块，扫到 0 个就红了。
搬之前那一遍「拿字面量对 `src/test`」对正则写的判据没用（正则里的字面片段不成句）。改成扫全前端，扰动 V9（标签去掉 `for`）见红。
以后搬之前另外看一眼：哪些判据对壳 `Pattern.compile`、它们的模式能不能匹配要挪走的那一段。

**判据**：扰动 9 个全红（模块表少一项、`zqShared` 少给 `htmlToMarkdown`、模块没解构 `renderMathIn`、保存前就删草稿、上传解析不说截断、待合入变更合不进去、
双链不支持 ⌘+点击开新标签、同一页再打开也压历史、导入来源的文件框标签没有 `for`），逐条看过红的原因。

**验**：全量 959 / 0 / 0 / 0（开着 Docker；第一遍红的那 1 条改完之后）；桌面应用重新打包。
