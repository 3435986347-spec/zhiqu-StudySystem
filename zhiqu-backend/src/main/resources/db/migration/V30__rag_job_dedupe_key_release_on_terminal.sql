-- 作业去重键在终态释放。
--
-- 背景：uk_rag_index_job_dedupe 是全局唯一键，而 enqueue 把 DuplicateKeyException 当幂等成功
-- 吞掉（RagIndexJobService.enqueue）。这对代次构建是对的——一份资料在一个代次里只该索引一次。
-- 但对增量钩子是错的，因为唯一键不区分作业状态：
--
--   用户编辑页 42 → upsert_unit:...:WIKI_PAGE#42 → 跑完 → COMPLETED
--   用户再编辑页 42 → 同一个 key → DuplicateKeyException → 吞掉 → 第二次编辑永不入索引
--
-- 没有报错，只有一行 debug 日志；页面本身好好的，只是它在检索里停在了上一版。
--
-- 为什么不是「把 canonical_hash 拼进 key」：那能挡住连续编辑，挡不住 A→B→A。
-- 改成 B、跑完，再改回 A 时，...#42:hash_A 这个 key 在第一次就用掉了，回退被去重掉，
-- 索引永远停在 B。那是绕开不变量，不是消除它。
--
-- 做法沿用 V29/V30 系列一直在用的可空唯一槽（MySQL 唯一键允许多个 NULL）：
-- 作业进终态时把 dedupe_key 置 NULL，唯一性于是只约束 PENDING / RETRY / RUNNING 的行。
--   保留：「同一目标不重复排队」
--   消除：「同一目标一辈子只能排一次」
--
-- 注意：本迁移必须在增量钩子接上之前应用。之后再补的话，存量终态行的 dedupe_key 还占着键，
-- 表现为「某些页第一次编辑后就再也不更新索引了」，且只能靠人工清历史键来恢复。

ALTER TABLE rag_index_job MODIFY dedupe_key VARCHAR(255) NULL;

-- 存量终态行一并释放。COMPLETED / SUPERSEDED / DEAD 是 rag_index_job 的全部终态
-- （PENDING / RUNNING / RETRY 为在途，必须继续占键）。
UPDATE rag_index_job
   SET dedupe_key = NULL
 WHERE status IN ('COMPLETED', 'SUPERSEDED', 'DEAD');
