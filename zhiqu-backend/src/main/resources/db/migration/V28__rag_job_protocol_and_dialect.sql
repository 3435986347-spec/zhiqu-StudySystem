-- RAG 作业协议字段：为「投影表 + unit_id」改造做准备。
--
-- 现状：rag_index_job 只有 user_id / notebook_id / source_id 三个维度，表达不了
-- 「按命名空间寻址的作业」（UPSERT_UNIT / DELETE_UNIT / DELETE_SCOPE / RECONCILE_UNITS）。
--
-- protocol_version 只服务一个目的：回滚到旧 JAR 时，让旧 worker 不会误领新格式作业。
-- 它不是用来区分双删的——双删的两条**都是** v2，靠 delete_dialect 区分方言。
--
-- delete_dialect 之所以必须存在于 dedupe key 里（见 RagIndexJobService.enqueue）：
-- 入队时的唯一键冲突是被 catch(DuplicateKeyException) 吞掉的，若两条删除的 dedupe key
-- 相同，第二条会**无声消失**，而 cutover 时恰好少掉的就是清理旧格式向量的那条。

ALTER TABLE rag_index_job
  ADD COLUMN protocol_version INT NOT NULL DEFAULT 1 COMMENT '1=旧 source 协议, 2=unit 协议' AFTER operation,
  ADD COLUMN unit_id BIGINT NULL AFTER source_id,
  ADD COLUMN namespace VARCHAR(20) NULL COMMENT 'NOTEBOOK_SOURCE | WIKI_PAGE | CONVERSATION_TURN' AFTER unit_id,
  ADD COLUMN delete_dialect VARCHAR(10) NULL COMMENT 'LEGACY=旧 SOURCE/NOTEBOOK 作用域, UNIT=新 UNIT/SCOPE 作用域' AFTER namespace,
  ADD COLUMN scope_kind VARCHAR(20) NULL COMMENT 'NOTEBOOK | WIKI_TREE | CONVERSATION' AFTER delete_dialect,
  ADD COLUMN scope_id BIGINT NULL AFTER scope_kind;

-- 领取查询新增了 protocol_version 前置条件，索引跟着它走；
-- 原 idx_rag_job_claim 保留，回滚到旧 JAR 后仍是它在用。
CREATE INDEX idx_rag_job_protocol_claim ON rag_index_job(protocol_version, status, next_retry_at, id);
