-- Knowledge page optimistic locking and revision read-version baseline.
ALTER TABLE user_knowledge_page
    ADD COLUMN version INT NOT NULL DEFAULT 0 COMMENT 'Optimistic lock version';

ALTER TABLE user_knowledge_revision
    ADD COLUMN base_page_version INT NULL COMMENT 'Target page version captured when the draft was created';
