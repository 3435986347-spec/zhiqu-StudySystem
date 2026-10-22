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

CREATE TABLE IF NOT EXISTS ai_agent_task (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  run_id BIGINT NOT NULL,
  parent_task_id BIGINT NULL,
  agent_type VARCHAR(64) NOT NULL,
  task_type VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  priority INT NOT NULL DEFAULT 0,
  parallel_group_id VARCHAR(64) NULL,
  depends_on_json MEDIUMTEXT NULL,
  input_json MEDIUMTEXT NULL,
  output_json MEDIUMTEXT NULL,
  public_summary VARCHAR(500) NULL,
  error_message VARCHAR(1000) NULL,
  started_at DATETIME NULL,
  completed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_agent_task_run (run_id, status),
  KEY idx_agent_task_parallel (run_id, parallel_group_id),
  KEY idx_agent_task_parent (parent_task_id),
  CONSTRAINT fk_agent_task_run FOREIGN KEY (run_id) REFERENCES ai_agent_run(id),
  CONSTRAINT fk_agent_task_parent FOREIGN KEY (parent_task_id) REFERENCES ai_agent_task(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ai_agent_claim (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  run_id BIGINT NOT NULL,
  step_id BIGINT NULL,
  task_id BIGINT NULL,
  claim_type VARCHAR(64) NOT NULL,
  content TEXT NOT NULL,
  confidence DECIMAL(5,4) NULL,
  evidence_ids_json MEDIUMTEXT NULL,
  metadata_json MEDIUMTEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_agent_claim_run (run_id),
  KEY idx_agent_claim_task (task_id),
  KEY idx_agent_claim_type (claim_type),
  CONSTRAINT fk_agent_claim_run FOREIGN KEY (run_id) REFERENCES ai_agent_run(id),
  CONSTRAINT fk_agent_claim_step FOREIGN KEY (step_id) REFERENCES ai_agent_step(id),
  CONSTRAINT fk_agent_claim_task FOREIGN KEY (task_id) REFERENCES ai_agent_task(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ai_agent_evidence (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  run_id BIGINT NOT NULL,
  task_id BIGINT NULL,
  step_id BIGINT NULL,
  source_type VARCHAR(64) NOT NULL,
  source_id VARCHAR(128) NULL,
  artifact_id BIGINT NULL,
  snippet TEXT NULL,
  metadata_json MEDIUMTEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_agent_evidence_run (run_id),
  KEY idx_agent_evidence_task (task_id),
  KEY idx_agent_evidence_source (source_type, source_id),
  CONSTRAINT fk_agent_evidence_run FOREIGN KEY (run_id) REFERENCES ai_agent_run(id),
  CONSTRAINT fk_agent_evidence_step FOREIGN KEY (step_id) REFERENCES ai_agent_step(id),
  CONSTRAINT fk_agent_evidence_task FOREIGN KEY (task_id) REFERENCES ai_agent_task(id),
  CONSTRAINT fk_agent_evidence_artifact FOREIGN KEY (artifact_id) REFERENCES ai_agent_artifact(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ai_verifier_finding (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  run_id BIGINT NOT NULL,
  task_id BIGINT NULL,
  severity VARCHAR(32) NOT NULL,
  code VARCHAR(64) NOT NULL,
  message VARCHAR(1000) NOT NULL,
  target_type VARCHAR(64) NULL,
  target_id BIGINT NULL,
  action VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_verifier_finding_run (run_id),
  KEY idx_verifier_finding_severity (severity),
  CONSTRAINT fk_verifier_finding_run FOREIGN KEY (run_id) REFERENCES ai_agent_run(id),
  CONSTRAINT fk_verifier_finding_task FOREIGN KEY (task_id) REFERENCES ai_agent_task(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CALL zhiqu_add_column_if_missing('ai_agent_step', 'task_id',
  'ALTER TABLE ai_agent_step ADD COLUMN task_id BIGINT NULL AFTER run_id');
CALL zhiqu_add_column_if_missing('ai_agent_step', 'parallel_group_id',
  'ALTER TABLE ai_agent_step ADD COLUMN parallel_group_id VARCHAR(64) NULL AFTER step_order');
CALL zhiqu_add_column_if_missing('ai_agent_step', 'attempt_no',
  'ALTER TABLE ai_agent_step ADD COLUMN attempt_no INT NOT NULL DEFAULT 1 AFTER parallel_group_id');
CALL zhiqu_add_index_if_missing('ai_agent_step', 'idx_ai_step_task',
  'CREATE INDEX idx_ai_step_task ON ai_agent_step(task_id)');

CALL zhiqu_add_column_if_missing('ai_agent_run', 'execution_mode',
  'ALTER TABLE ai_agent_run ADD COLUMN execution_mode VARCHAR(32) NOT NULL DEFAULT ''SERIAL'' AFTER context_options_json');
CALL zhiqu_add_column_if_missing('ai_agent_run', 'max_steps',
  'ALTER TABLE ai_agent_run ADD COLUMN max_steps INT NOT NULL DEFAULT 20 AFTER execution_mode');
CALL zhiqu_add_column_if_missing('ai_agent_run', 'max_parallel_tasks',
  'ALTER TABLE ai_agent_run ADD COLUMN max_parallel_tasks INT NOT NULL DEFAULT 3 AFTER max_steps');
CALL zhiqu_add_column_if_missing('ai_agent_run', 'max_tokens',
  'ALTER TABLE ai_agent_run ADD COLUMN max_tokens INT NULL AFTER max_parallel_tasks');
CALL zhiqu_add_column_if_missing('ai_agent_run', 'timeout_seconds',
  'ALTER TABLE ai_agent_run ADD COLUMN timeout_seconds INT NOT NULL DEFAULT 120 AFTER max_tokens');

DROP PROCEDURE zhiqu_add_column_if_missing;
DROP PROCEDURE zhiqu_add_index_if_missing;
