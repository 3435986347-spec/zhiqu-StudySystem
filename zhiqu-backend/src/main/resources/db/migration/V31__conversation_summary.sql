-- 会话滚动摘要：对话历史此前是硬截断（CHAT_HISTORY_LIMIT = 20），第 21 轮之前的内容
-- 直接从模型视野里消失。这四列让更早的轮次以压缩形式留下来。
--
-- 全部可空、加法式迁移：存量会话的四列都是 NULL，读侧当作「还没有摘要」，行为与今天完全一致。
--
-- 为什么指纹只有一列 count，而不是 count + max(id)
--
--   摘要覆盖的区间是 id <= summary_upto_message_id。ai_message.id 是 AUTO_INCREMENT
--   （V4:15），新消息只会落在区间之外，区间内不可能插入；而全仓库没有任何一处把
--   ai_message.deleted 写回 0（软删只有 0 → 1 一个方向，会话「复活」是 ai_conversation
--   的 upsert，不动消息行）。于是区间内只剩删除一种变化，而任何一次删除都让存活数减一。
--   max(id) 不存在能单独触发的场景，它是 count 的子集，不是互补的另一个维度。
--
--   记在这里是因为：两列会让下一个人以为各防一类变化，然后在扩指纹时试图维持对称性。
--   一列不是遗漏，是那一维真的不承重。
--
-- 指纹覆盖不到什么（重要）
--
--   它只覆盖「删除」，不覆盖「原地修改已滑出窗口的消息」。今天够用，靠的是「没有任何路径
--   原地改已出窗消息」这个当前事实——所有改消息的落点改的都是当轮消息，当轮消息在窗口内。
--   哪天加「编辑历史消息」，count 纹丝不动，摘要里会留着已被改掉的内容，而删除那条判据照样绿。
--   那时必须把内容变更纳进指纹，而 ai_message 没有 updated_at 列（只有 created_at /
--   completed_at），要给这张热表再加一次迁移。现在知道比那天知道便宜。

ALTER TABLE ai_conversation
    ADD COLUMN encrypted_summary MEDIUMTEXT NULL COMMENT '滚动摘要密文（复用 app.crypto.master-key）',
    ADD COLUMN summary_upto_message_id BIGINT NULL COMMENT '摘要覆盖到这条消息（含）；区间即 id <= 此值',
    ADD COLUMN summary_live_count INT NULL COMMENT '读侧指纹：生成摘要时区间内的存活消息数',
    ADD COLUMN summary_updated_at DATETIME NULL COMMENT '摘要最后一次重算的时间';
