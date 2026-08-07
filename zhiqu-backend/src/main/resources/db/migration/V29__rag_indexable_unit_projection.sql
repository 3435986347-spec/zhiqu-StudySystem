-- RAG 语料投影表：把「Notebook 资料 / Wiki 页 / 会话轮次」收敛成一种可索引单元。
--
-- 为什么要投影表而不是「按类型各查各的」：代次展开、进度核算、启用门禁三处各有一份
-- `SELECT ... FROM ai_notebook_source WHERE status='READY'`。漏改任一处，覆盖率就会少算，
-- 于是代次带着没建完的向量转 ACTIVE——不报错，只是检索结果悄悄少了一块。
-- 收敛成同一条查询后，将来加第四个命名空间对作业调度与管理端是零改动。
--
-- 为什么用代理主键 id 而不是复用各自的业务 id：跨命名空间的 id 会撞车。资料 7 与 Wiki 页 7
-- 在向量库里必须是两个东西，而 vector_id、唯一键、扫删条件此前全都只带 sourceId。
-- 全局唯一的 unit id 从根上消掉这类撞车，而不是在四个地方各补一次判断。
--
-- 注意：本迁移只建表，不填数据。投影行由 RECONCILE_UNITS 作业从原始表枚举
-- （Wiki 正文加密，SQL 里取不到明文，无法在迁移中回填）。因此在 reconcile 跑完之前
-- 本表是空的——凡是依赖它做分母的逻辑都必须等到那之后才能切换，否则会把「什么都没有」
-- 误判成「全都覆盖了」。

CREATE TABLE IF NOT EXISTS rag_indexable_unit (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  namespace VARCHAR(20) NOT NULL COMMENT 'NOTEBOOK_SOURCE | WIKI_PAGE | CONVERSATION_TURN',
  ref_id BIGINT NOT NULL COMMENT '原始表主键；CONVERSATION_TURN 取助手消息 id',
  scope_kind VARCHAR(20) NOT NULL COMMENT 'NOTEBOOK | WIKI_TREE | CONVERSATION',
  scope_id BIGINT NULL,
  title VARCHAR(200) NOT NULL,
  source_type VARCHAR(40) NOT NULL,
  canonical_hash CHAR(64) NULL COMMENT '规范化全文的 sha256；钩子与 worker 必须算出同一个值',
  chunk_count INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'READY' COMMENT 'READY | RETIRED | SKIPPED',
  index_status VARCHAR(20) NOT NULL DEFAULT 'NOT_INDEXED',
  index_version VARCHAR(120) NULL,
  index_error VARCHAR(1000) NULL,
  indexed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_rag_unit_ns_ref (namespace, ref_id),
  KEY idx_rag_unit_status_id (status, id),
  KEY idx_rag_unit_user_scope (user_id, namespace, scope_kind, scope_id),
  KEY idx_rag_unit_user_created (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 只存切分边界与哈希，正文永不落地。
--
-- Wiki 正文在 user_knowledge_page 里是密文，解密只在 JVM 内短暂发生；sidecar 那边同样
-- 只收 embedding 与 offset、不收正文。若在这里存一份明文 chunk，等于把整条加密边界打穿
-- ——contentSummary 那 500 字是有意为之的有界泄漏，一张 chunk 表则是无界的。
--
-- char_start/char_end 的单位是 Unicode code point，不是 Java 的 UTF-16 code unit。
-- Python 侧 len() 本就按 code point 计数，两边必须一致，否则含星平面字符（如 emoji）的
-- 文本回读时会错位——错位不会抛异常，只会截出一段偏移了几个字的内容。
CREATE TABLE IF NOT EXISTS rag_unit_chunk (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  unit_id BIGINT NOT NULL,
  chunk_index INT NOT NULL,
  char_start INT NOT NULL COMMENT 'Unicode code point 偏移，非 UTF-16 code unit',
  char_end INT NOT NULL,
  content_hash CHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_rag_unit_chunk_index (unit_id, chunk_index),
  CONSTRAINT fk_rag_unit_chunk_unit FOREIGN KEY (unit_id) REFERENCES rag_indexable_unit(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 索引状态表挂上 unit 维度。
--
-- 保留 source_id 与 uk_rag_source_generation 不动：MySQL 唯一键允许多个 NULL，所以
-- Wiki/会话行（source_id 为 NULL）互不冲突，Notebook 行的唯一性与今天完全一致。
-- 这是回滚生命线——回退到旧 JAR 时它照常读写 source_id，只是看不见 NULL 的那些行。
-- 代价仅是一个可空 BIGINT，留到最后一次迁移再删，或者永不删。
ALTER TABLE rag_source_index_state
  ADD COLUMN unit_id BIGINT NULL AFTER source_id,
  MODIFY source_id BIGINT NULL;

CREATE UNIQUE INDEX uk_rag_source_state_unit ON rag_source_index_state(unit_id, generation_id);
