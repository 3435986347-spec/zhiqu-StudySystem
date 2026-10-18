# 知识 Wiki 与参考计划

> 原来是 `CLAUDE.md` 里的「Knowledge Wiki」「Shared plans」，第三十八轮（方案第 5 步，`CLAUDE.md` 瘦身）原样挪到这里，一字未改。
> `CLAUDE.md` 现在只留规矩；这里是来龙去脉和细节。文中「上面」「下面」指的是原来 `CLAUDE.md` 里的位置。

### Knowledge Wiki

Pages → revisions → patch sets ("待合入变更"). AI edits land as drafts and only reach a page through
the single guarded entry point `upsertRevisionPage`. Two independent protections:

- **Optimistic lock** — `user_knowledge_page.version` (`@Version`). Write APIs require the client's
  `version`; `reparentByVersion` / `softDeleteByVersion` carry it in the `WHERE`, and
  `updateById(...) != 1` raises `知识页已被其他窗口修改，请刷新后重试`.
- **Draft baseline** — a revision stores `base_content_hash` (title + body) and `base_page_version`
  captured **when the agent read the page**, in memory, from the same text handed to the model.
  Apply is refused if the page changed since, if the draft has no baseline, or if the request tries
  to re-point a bound draft at a different page.

Structure fields (`parentId`/`sortOrder`/`pinned`) are only modified when the request body actually
contains that key — so applying a patch with an empty body never moves a child page to the root.

**正文的两种口径（第七十一轮）**：用户自己保存的正文原样存、原样读回（`savePage` / `pageRow` 只把 CRLF 统一成 LF，旧的 Markdown 导出也写原文、以换行结尾）。
`MarkdownCanonicalizer.clean()`（剥开头的代码围栏、删「已经…知识库」那样的模型自述行、去首尾空白）只用在 AI 写的内容（修订、待合入变更）和比对上：
页状态哈希、给模型的快照（`findPageSnapshotByTitle`）、RAG 的规范全文都是 `clean(解密)`，两边同一个口径，所以存量不用重算。
第七十一轮之前用户保存也过 `clean()`：Obsidian 文件结尾的换行没了、一页以代码块开头时代码块被剥坏、「我已经把资料整理进知识库了」这一行被删。

### Shared plans

Submissions go `PENDING` → `APPROVED` / `REJECTED` / `OFFLINE`. The rejection reason is stored
**twice on purpose** and the two copies are not redundant: `shared_plan_template.rejection_reason`
is the reason for the *current* status (nulled when the plan is not rejected) and
`shared_plan_review.note` is the append-only audit trail (every review ever made). Do not
"clean up" one of them without moving its consumer.

`GET /api/shared-plans/mine` is what makes the admin UI's promise true — the reject dialog says
"驳回原因（可选，将展示给提交者）", and until 2026-09-21 nothing showed it: `publicList` returns
only `APPROVED`, `reviews` appears only in `adminDetail`, and `rejection_reason` had **zero
readers**. Admins wrote careful explanations that went nowhere, and submitters were never told
their plan had been rejected at all.
