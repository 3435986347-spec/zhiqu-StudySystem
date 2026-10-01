DROP PROCEDURE IF EXISTS zhiqu_add_column_if_missing;
DROP PROCEDURE IF EXISTS zhiqu_add_index_if_missing;

DELIMITER //

CREATE PROCEDURE zhiqu_add_column_if_missing(
  IN p_table_name VARCHAR(128),
  IN p_column_name VARCHAR(128),
  IN p_sql TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = p_table_name
      AND COLUMN_NAME = p_column_name
  ) THEN
    SET @ddl = p_sql;
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END//

CREATE PROCEDURE zhiqu_add_index_if_missing(
  IN p_table_name VARCHAR(128),
  IN p_index_name VARCHAR(128),
  IN p_sql TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = p_table_name
      AND INDEX_NAME = p_index_name
  ) THEN
    SET @ddl = p_sql;
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END//

DELIMITER ;

CALL zhiqu_add_column_if_missing('study_task', 'encrypted_title',
  'ALTER TABLE study_task ADD COLUMN encrypted_title MEDIUMTEXT NULL AFTER title');
CALL zhiqu_add_column_if_missing('study_task', 'encrypted_description',
  'ALTER TABLE study_task ADD COLUMN encrypted_description MEDIUMTEXT NULL AFTER description');
CALL zhiqu_add_column_if_missing('study_task', 'encryption_version',
  'ALTER TABLE study_task ADD COLUMN encryption_version VARCHAR(20) DEFAULT NULL AFTER encrypted_description');
CALL zhiqu_add_column_if_missing('user_ai_memory', 'encrypted_memory_text',
  'ALTER TABLE user_ai_memory ADD COLUMN encrypted_memory_text MEDIUMTEXT NULL AFTER memory_text');
CALL zhiqu_add_column_if_missing('user_ai_memory', 'encryption_version',
  'ALTER TABLE user_ai_memory ADD COLUMN encryption_version VARCHAR(20) DEFAULT NULL AFTER encrypted_memory_text');

CREATE TABLE IF NOT EXISTS ai_model_config (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NULL,
  owner_type VARCHAR(20) NOT NULL DEFAULT 'USER',
  provider_type VARCHAR(40) NOT NULL DEFAULT 'OPENAI_COMPATIBLE',
  display_name VARCHAR(100) NOT NULL,
  api_url VARCHAR(500) NOT NULL,
  encrypted_api_key MEDIUMTEXT NULL,
  model_name VARCHAR(120) NOT NULL,
  capabilities VARCHAR(200) DEFAULT 'TEXT',
  daily_quota INT DEFAULT NULL,
  used_today INT DEFAULT 0,
  quota_date DATE DEFAULT NULL,
  enabled TINYINT DEFAULT 1,
  is_default TINYINT DEFAULT 0,
  encryption_version VARCHAR(20) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted TINYINT DEFAULT 0,
  CONSTRAINT fk_ai_model_config_user FOREIGN KEY (user_id) REFERENCES sys_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_knowledge_page (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  page_type VARCHAR(40) NOT NULL DEFAULT 'NOTE',
  title VARCHAR(120) NOT NULL,
  encrypted_content MEDIUMTEXT NULL,
  content_summary VARCHAR(500) DEFAULT NULL,
  source_message_id BIGINT DEFAULT NULL,
  encryption_version VARCHAR(20) DEFAULT 'v1',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted TINYINT DEFAULT 0,
  CONSTRAINT fk_knowledge_page_user FOREIGN KEY (user_id) REFERENCES sys_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_knowledge_revision (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  page_id BIGINT DEFAULT NULL,
  action_type VARCHAR(20) NOT NULL,
  title VARCHAR(120) DEFAULT NULL,
  encrypted_content MEDIUMTEXT NULL,
  status VARCHAR(20) DEFAULT 'PENDING',
  source_message_id BIGINT DEFAULT NULL,
  encryption_version VARCHAR(20) DEFAULT 'v1',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  applied_at DATETIME DEFAULT NULL,
  deleted TINYINT DEFAULT 0,
  CONSTRAINT fk_knowledge_revision_user FOREIGN KEY (user_id) REFERENCES sys_user(id),
  CONSTRAINT fk_knowledge_revision_page FOREIGN KEY (page_id) REFERENCES user_knowledge_page(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS device_push_token (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  device_type VARCHAR(40) NOT NULL DEFAULT 'PWA',
  endpoint_hash VARCHAR(128) NOT NULL,
  encrypted_token MEDIUMTEXT NULL,
  permission_status VARCHAR(30) DEFAULT 'UNKNOWN',
  user_agent VARCHAR(500) DEFAULT NULL,
  last_active_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  encryption_version VARCHAR(20) DEFAULT 'v1',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted TINYINT DEFAULT 0,
  CONSTRAINT fk_device_push_user FOREIGN KEY (user_id) REFERENCES sys_user(id),
  UNIQUE KEY uk_device_user_endpoint (user_id, endpoint_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS shared_plan_template (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  title VARCHAR(160) NOT NULL,
  description VARCHAR(1000) DEFAULT NULL,
  category VARCHAR(60) DEFAULT 'GENERAL',
  target_audience VARCHAR(200) DEFAULT NULL,
  status VARCHAR(20) DEFAULT 'PENDING',
  anonymized TINYINT DEFAULT 0,
  reviewed_by BIGINT DEFAULT NULL,
  reviewed_at DATETIME DEFAULT NULL,
  rejection_reason VARCHAR(500) DEFAULT NULL,
  apply_count INT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted TINYINT DEFAULT 0,
  CONSTRAINT fk_shared_plan_user FOREIGN KEY (user_id) REFERENCES sys_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS shared_plan_task_template (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  template_id BIGINT NOT NULL,
  title VARCHAR(200) NOT NULL,
  description VARCHAR(1000) DEFAULT NULL,
  relative_start_day INT DEFAULT NULL,
  relative_deadline_day INT DEFAULT NULL,
  preferred_time VARCHAR(8) DEFAULT NULL,
  duration_minutes INT DEFAULT NULL,
  task_type VARCHAR(50) DEFAULT NULL,
  difficulty INT DEFAULT NULL,
  quadrant INT DEFAULT 2,
  priority INT DEFAULT 1,
  reminder_offsets VARCHAR(100) DEFAULT NULL,
  sort_order INT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted TINYINT DEFAULT 0,
  CONSTRAINT fk_shared_plan_task_template FOREIGN KEY (template_id) REFERENCES shared_plan_template(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS shared_plan_routine_template (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  template_id BIGINT NOT NULL,
  title VARCHAR(200) NOT NULL,
  description VARCHAR(1000) DEFAULT NULL,
  frequency VARCHAR(20) DEFAULT 'DAILY',
  days_of_week VARCHAR(50) DEFAULT NULL,
  relative_start_day INT DEFAULT 0,
  relative_end_day INT DEFAULT 29,
  preferred_time VARCHAR(8) DEFAULT NULL,
  duration_minutes INT DEFAULT NULL,
  task_type VARCHAR(50) DEFAULT NULL,
  difficulty INT DEFAULT NULL,
  quadrant INT DEFAULT 2,
  priority INT DEFAULT 1,
  reminder_enabled TINYINT DEFAULT 1,
  reminder_offsets VARCHAR(100) DEFAULT '0',
  sort_order INT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted TINYINT DEFAULT 0,
  CONSTRAINT fk_shared_plan_routine_template FOREIGN KEY (template_id) REFERENCES shared_plan_template(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS shared_plan_review (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  template_id BIGINT NOT NULL,
  reviewer_id BIGINT NOT NULL,
  action VARCHAR(20) NOT NULL,
  note VARCHAR(500) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_shared_plan_review_template FOREIGN KEY (template_id) REFERENCES shared_plan_template(id),
  CONSTRAINT fk_shared_plan_review_user FOREIGN KEY (reviewer_id) REFERENCES sys_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CALL zhiqu_add_index_if_missing('ai_model_config', 'idx_ai_model_user_owner',
  'CREATE INDEX idx_ai_model_user_owner ON ai_model_config(user_id, owner_type, enabled, deleted)');
CALL zhiqu_add_index_if_missing('user_knowledge_page', 'idx_knowledge_user_type',
  'CREATE INDEX idx_knowledge_user_type ON user_knowledge_page(user_id, page_type, deleted)');
CALL zhiqu_add_index_if_missing('shared_plan_template', 'idx_shared_plan_status_category',
  'CREATE INDEX idx_shared_plan_status_category ON shared_plan_template(status, category, deleted, created_at)');

DROP PROCEDURE zhiqu_add_column_if_missing;
DROP PROCEDURE zhiqu_add_index_if_missing;
