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
    SELECT 1
    FROM INFORMATION_SCHEMA.COLUMNS
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
    SELECT 1
    FROM INFORMATION_SCHEMA.STATISTICS
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

CALL zhiqu_add_column_if_missing('study_task', 'version',
  'ALTER TABLE study_task ADD COLUMN version INT NOT NULL DEFAULT 0 AFTER updated_at');
CALL zhiqu_add_column_if_missing('sys_user', 'version',
  'ALTER TABLE sys_user ADD COLUMN version INT NOT NULL DEFAULT 0 AFTER updated_at');

CALL zhiqu_add_index_if_missing('study_task', 'idx_task_user_status_deadline',
  'CREATE INDEX idx_task_user_status_deadline ON study_task(user_id, status, deadline)');
CALL zhiqu_add_index_if_missing('study_record', 'idx_record_user_date_v2',
  'CREATE INDEX idx_record_user_date_v2 ON study_record(user_id, study_date)');
CALL zhiqu_add_index_if_missing('task_reminder', 'idx_task_reminder_due_deleted',
  'CREATE INDEX idx_task_reminder_due_deleted ON task_reminder(status, scheduled_at, deleted)');
CALL zhiqu_add_index_if_missing('runtime_issue', 'idx_runtime_issue_user_status_created',
  'CREATE INDEX idx_runtime_issue_user_status_created ON runtime_issue(user_id, status, created_at)');

DROP PROCEDURE zhiqu_add_column_if_missing;
DROP PROCEDURE zhiqu_add_index_if_missing;
