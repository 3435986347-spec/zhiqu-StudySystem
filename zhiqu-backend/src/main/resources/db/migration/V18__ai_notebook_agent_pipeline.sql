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

CREATE TABLE IF NOT EXISTS ai_notebook (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  title VARCHAR(120) NOT NULL,
  description VARCHAR(500) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted TINYINT(1) NOT NULL DEFAULT 0,
  KEY idx_ai_notebook_user_deleted (user_id, deleted),
  CONSTRAINT fk_ai_notebook_user FOREIGN KEY (user_id) REFERENCES sys_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ai_notebook_source (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  notebook_id BIGINT NOT NULL,
  knowledge_source_id BIGINT NULL,
  source_type VARCHAR(40) NOT NULL,
  title VARCHAR(180) NOT NULL,
  url VARCHAR(1000) NULL,
  file_path VARCHAR(500) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'UPLOADED',
  parse_error VARCHAR(1000) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted TINYINT(1) NOT NULL DEFAULT 0,
  KEY idx_ai_source_user_notebook_status (user_id, notebook_id, status, deleted),
  KEY idx_ai_source_knowledge (knowledge_source_id),
  CONSTRAINT fk_ai_source_user FOREIGN KEY (user_id) REFERENCES sys_user(id),
  CONSTRAINT fk_ai_source_notebook FOREIGN KEY (notebook_id) REFERENCES ai_notebook(id),
  CONSTRAINT fk_ai_source_knowledge FOREIGN KEY (knowledge_source_id) REFERENCES knowledge_source(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ai_source_chunk (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  source_id BIGINT NOT NULL,
  knowledge_source_id BIGINT NULL,
  chunk_index INT NOT NULL,
  content MEDIUMTEXT NOT NULL,
  metadata_json MEDIUMTEXT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ai_chunk_source_index (source_id, chunk_index),
  KEY idx_ai_chunk_knowledge (knowledge_source_id),
  CONSTRAINT fk_ai_chunk_source FOREIGN KEY (source_id) REFERENCES ai_notebook_source(id),
  CONSTRAINT fk_ai_chunk_knowledge FOREIGN KEY (knowledge_source_id) REFERENCES knowledge_source(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ai_agent_run (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  user_message_id BIGINT NULL,
  assistant_message_id BIGINT NULL,
  notebook_id BIGINT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  agent_mode VARCHAR(20) NOT NULL DEFAULT 'AUTO',
  context_options_json MEDIUMTEXT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME NULL,
  error_message VARCHAR(500) NULL,
  KEY idx_ai_run_user_notebook_created (user_id, notebook_id, created_at),
  KEY idx_ai_run_messages (user_message_id, assistant_message_id),
  CONSTRAINT fk_ai_run_user FOREIGN KEY (user_id) REFERENCES sys_user(id),
  CONSTRAINT fk_ai_run_user_message FOREIGN KEY (user_message_id) REFERENCES ai_message(id),
  CONSTRAINT fk_ai_run_assistant_message FOREIGN KEY (assistant_message_id) REFERENCES ai_message(id),
  CONSTRAINT fk_ai_run_notebook FOREIGN KEY (notebook_id) REFERENCES ai_notebook(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ai_agent_step (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  run_id BIGINT NOT NULL,
  agent_type VARCHAR(40) NOT NULL,
  step_order INT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  public_summary VARCHAR(500) NULL,
  input_summary VARCHAR(1000) NULL,
  output_summary VARCHAR(1000) NULL,
  error_message VARCHAR(500) NULL,
  started_at DATETIME NULL,
  completed_at DATETIME NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ai_step_run_order (run_id, step_order),
  CONSTRAINT fk_ai_step_run FOREIGN KEY (run_id) REFERENCES ai_agent_run(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ai_agent_artifact (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  run_id BIGINT NOT NULL,
  step_id BIGINT NULL,
  artifact_type VARCHAR(40) NOT NULL,
  title VARCHAR(180) NOT NULL,
  content_json MEDIUMTEXT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  target_type VARCHAR(40) NULL,
  target_id BIGINT NULL,
  source_message_id BIGINT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_ai_artifact_run_type_status (run_id, artifact_type, status),
  KEY idx_ai_artifact_target (target_type, target_id),
  CONSTRAINT fk_ai_artifact_run FOREIGN KEY (run_id) REFERENCES ai_agent_run(id),
  CONSTRAINT fk_ai_artifact_step FOREIGN KEY (step_id) REFERENCES ai_agent_step(id),
  CONSTRAINT fk_ai_artifact_source_message FOREIGN KEY (source_message_id) REFERENCES ai_message(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CALL zhiqu_add_column_if_missing('ai_message', 'agent_run_id',
  'ALTER TABLE ai_message ADD COLUMN agent_run_id BIGINT NULL AFTER conversation_id');
CALL zhiqu_add_index_if_missing('ai_message', 'idx_ai_message_agent_run',
  'CREATE INDEX idx_ai_message_agent_run ON ai_message(user_id, agent_run_id, deleted)');

DROP PROCEDURE zhiqu_add_column_if_missing;
DROP PROCEDURE zhiqu_add_index_if_missing;
