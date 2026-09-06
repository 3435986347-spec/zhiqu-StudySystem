-- V21：知识草稿基准版本哈希，用于合入前冲突检测（防止陈旧草稿覆盖用户后来的改动）。
-- 可空、纯新增列：老数据 base_content_hash 为 NULL，合入时跳过冲突检测，向后兼容。
ALTER TABLE user_knowledge_revision
    ADD COLUMN base_content_hash VARCHAR(64) NULL COMMENT '草稿生成时目标页正文哈希，合入前比对以检测冲突';
