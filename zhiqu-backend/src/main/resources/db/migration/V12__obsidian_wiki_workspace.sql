DROP PROCEDURE IF EXISTS zhiqu_add_column_if_missing;
DROP PROCEDURE IF EXISTS zhiqu_add_index_if_missing;

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

CREATE TABLE IF NOT EXISTS knowledge_source (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  source_type VARCHAR(40) NOT NULL DEFAULT 'NOTE',
  title VARCHAR(180) NOT NULL,
  source_ref VARCHAR(500) DEFAULT NULL,
  encrypted_content MEDIUMTEXT NULL,
  content_summary VARCHAR(800) DEFAULT NULL,
  conversation_id BIGINT DEFAULT NULL,
  message_id BIGINT DEFAULT NULL,
  immutable_hash VARCHAR(128) DEFAULT NULL,
  encryption_version VARCHAR(20) DEFAULT 'v1',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted TINYINT DEFAULT 0,
  CONSTRAINT fk_knowledge_source_user FOREIGN KEY (user_id) REFERENCES sys_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS knowledge_patch_set (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  title VARCHAR(180) NOT NULL,
  summary VARCHAR(1200) DEFAULT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  trigger_type VARCHAR(40) DEFAULT 'CHAT',
  source_conversation_id BIGINT DEFAULT NULL,
  source_message_id BIGINT DEFAULT NULL,
  applied_at DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted TINYINT DEFAULT 0,
  CONSTRAINT fk_knowledge_patch_user FOREIGN KEY (user_id) REFERENCES sys_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS knowledge_page_link (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  source_page_id BIGINT NOT NULL,
  target_page_id BIGINT DEFAULT NULL,
  target_title VARCHAR(180) NOT NULL,
  link_type VARCHAR(30) NOT NULL DEFAULT 'WIKI',
  anchor_text VARCHAR(180) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted TINYINT DEFAULT 0,
  CONSTRAINT fk_knowledge_link_user FOREIGN KEY (user_id) REFERENCES sys_user(id),
  CONSTRAINT fk_knowledge_link_source FOREIGN KEY (source_page_id) REFERENCES user_knowledge_page(id),
  CONSTRAINT fk_knowledge_link_target FOREIGN KEY (target_page_id) REFERENCES user_knowledge_page(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS knowledge_operation_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  operation_type VARCHAR(40) NOT NULL,
  page_id BIGINT DEFAULT NULL,
  patch_set_id BIGINT DEFAULT NULL,
  source_id BIGINT DEFAULT NULL,
  title VARCHAR(180) NOT NULL,
  detail VARCHAR(1200) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted TINYINT DEFAULT 0,
  CONSTRAINT fk_knowledge_log_user FOREIGN KEY (user_id) REFERENCES sys_user(id),
  CONSTRAINT fk_knowledge_log_page FOREIGN KEY (page_id) REFERENCES user_knowledge_page(id),
  CONSTRAINT fk_knowledge_log_patch FOREIGN KEY (patch_set_id) REFERENCES knowledge_patch_set(id),
  CONSTRAINT fk_knowledge_log_source FOREIGN KEY (source_id) REFERENCES knowledge_source(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CALL zhiqu_add_column_if_missing('user_knowledge_revision', 'patch_set_id',
  'patch_set_id BIGINT NULL AFTER user_id');

CALL zhiqu_add_index_if_missing('knowledge_source', 'idx_knowledge_source_user',
  'CREATE INDEX idx_knowledge_source_user ON knowledge_source(user_id, source_type, deleted, created_at)');
CALL zhiqu_add_index_if_missing('knowledge_patch_set', 'idx_knowledge_patch_user_status',
  'CREATE INDEX idx_knowledge_patch_user_status ON knowledge_patch_set(user_id, status, deleted, created_at)');
CALL zhiqu_add_index_if_missing('knowledge_page_link', 'idx_knowledge_link_source',
  'CREATE INDEX idx_knowledge_link_source ON knowledge_page_link(user_id, source_page_id, deleted)');
CALL zhiqu_add_index_if_missing('knowledge_page_link', 'idx_knowledge_link_target',
  'CREATE INDEX idx_knowledge_link_target ON knowledge_page_link(user_id, target_page_id, target_title, deleted)');
CALL zhiqu_add_index_if_missing('knowledge_operation_log', 'idx_knowledge_log_user_created',
  'CREATE INDEX idx_knowledge_log_user_created ON knowledge_operation_log(user_id, deleted, created_at)');
CALL zhiqu_add_index_if_missing('user_knowledge_revision', 'idx_knowledge_revision_patch',
  'CREATE INDEX idx_knowledge_revision_patch ON user_knowledge_revision(user_id, patch_set_id, status, deleted)');

DROP PROCEDURE IF EXISTS zhiqu_add_column_if_missing;
DROP PROCEDURE IF EXISTS zhiqu_add_index_if_missing;
