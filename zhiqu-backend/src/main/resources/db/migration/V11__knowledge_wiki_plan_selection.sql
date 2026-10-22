DROP PROCEDURE IF EXISTS zhiqu_add_column_if_missing;
DELIMITER //
CREATE PROCEDURE zhiqu_add_column_if_missing(
  IN p_table VARCHAR(128),
  IN p_column VARCHAR(128),
  IN p_definition TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = p_table
      AND COLUMN_NAME = p_column
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE ', p_table, ' ADD COLUMN ', p_definition);
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END//
DELIMITER ;

DROP PROCEDURE IF EXISTS zhiqu_add_index_if_missing;
DELIMITER //
CREATE PROCEDURE zhiqu_add_index_if_missing(
  IN p_table VARCHAR(128),
  IN p_index VARCHAR(128),
  IN p_definition TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = p_table
      AND INDEX_NAME = p_index
  ) THEN
    SET @ddl = p_definition;
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END//
DELIMITER ;

CALL zhiqu_add_column_if_missing('user_knowledge_page', 'parent_id',
  'parent_id BIGINT NULL AFTER user_id');
CALL zhiqu_add_column_if_missing('user_knowledge_page', 'sort_order',
  'sort_order INT NOT NULL DEFAULT 0 AFTER page_type');
CALL zhiqu_add_column_if_missing('user_knowledge_page', 'source_conversation_id',
  'source_conversation_id BIGINT NULL AFTER source_message_id');
CALL zhiqu_add_column_if_missing('user_knowledge_page', 'pinned',
  'pinned TINYINT NOT NULL DEFAULT 0 AFTER source_conversation_id');
CALL zhiqu_add_column_if_missing('user_knowledge_page', 'last_used_at',
  'last_used_at DATETIME NULL AFTER pinned');

CALL zhiqu_add_column_if_missing('user_knowledge_revision', 'source_conversation_id',
  'source_conversation_id BIGINT NULL AFTER source_message_id');

CALL zhiqu_add_index_if_missing('user_knowledge_page', 'idx_knowledge_tree',
  'CREATE INDEX idx_knowledge_tree ON user_knowledge_page(user_id, parent_id, sort_order, deleted)');
CALL zhiqu_add_index_if_missing('user_knowledge_revision', 'idx_knowledge_revision_status',
  'CREATE INDEX idx_knowledge_revision_status ON user_knowledge_revision(user_id, status, deleted, created_at)');

DROP PROCEDURE IF EXISTS zhiqu_add_column_if_missing;
DROP PROCEDURE IF EXISTS zhiqu_add_index_if_missing;
