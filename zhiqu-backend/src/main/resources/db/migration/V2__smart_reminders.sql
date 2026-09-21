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

CALL zhiqu_add_column_if_missing('study_task', 'task_type',
  'ALTER TABLE study_task ADD COLUMN task_type VARCHAR(50) DEFAULT NULL AFTER repeat_week_number');
CALL zhiqu_add_column_if_missing('study_task', 'difficulty',
  'ALTER TABLE study_task ADD COLUMN difficulty TINYINT DEFAULT NULL AFTER task_type');
CALL zhiqu_add_column_if_missing('study_task', 'ai_reminder_reason',
  'ALTER TABLE study_task ADD COLUMN ai_reminder_reason VARCHAR(500) DEFAULT NULL AFTER difficulty');

CREATE TABLE IF NOT EXISTS user_reminder_setting (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL UNIQUE,
  channel VARCHAR(30) DEFAULT 'PUSHPLUS',
  webhook_url VARCHAR(1000),
  qq_app_id VARCHAR(100),
  qq_app_secret VARCHAR(500),
  qq_group_openid VARCHAR(200),
  qq_sandbox TINYINT DEFAULT 0,
  pushplus_token VARCHAR(500),
  enabled TINYINT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_reminder_setting_user FOREIGN KEY (user_id) REFERENCES sys_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CALL zhiqu_add_column_if_missing('user_reminder_setting', 'qq_app_id',
  'ALTER TABLE user_reminder_setting ADD COLUMN qq_app_id VARCHAR(100) DEFAULT NULL AFTER webhook_url');
CALL zhiqu_add_column_if_missing('user_reminder_setting', 'qq_app_secret',
  'ALTER TABLE user_reminder_setting ADD COLUMN qq_app_secret VARCHAR(500) DEFAULT NULL AFTER qq_app_id');
CALL zhiqu_add_column_if_missing('user_reminder_setting', 'qq_group_openid',
  'ALTER TABLE user_reminder_setting ADD COLUMN qq_group_openid VARCHAR(200) DEFAULT NULL AFTER qq_app_secret');
CALL zhiqu_add_column_if_missing('user_reminder_setting', 'qq_sandbox',
  'ALTER TABLE user_reminder_setting ADD COLUMN qq_sandbox TINYINT DEFAULT 0 AFTER qq_group_openid');
CALL zhiqu_add_column_if_missing('user_reminder_setting', 'pushplus_token',
  'ALTER TABLE user_reminder_setting ADD COLUMN pushplus_token VARCHAR(500) DEFAULT NULL AFTER qq_sandbox');

CREATE TABLE IF NOT EXISTS task_reminder (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  task_id BIGINT NOT NULL,
  offset_days INT,
  reminder_type VARCHAR(30) DEFAULT 'AUTO',
  scheduled_at DATETIME NOT NULL,
  status VARCHAR(20) DEFAULT 'PENDING',
  sent_at DATETIME,
  failure_reason VARCHAR(500),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted TINYINT DEFAULT 0,
  CONSTRAINT fk_task_reminder_user FOREIGN KEY (user_id) REFERENCES sys_user(id),
  CONSTRAINT fk_task_reminder_task FOREIGN KEY (task_id) REFERENCES study_task(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CALL zhiqu_add_index_if_missing('task_reminder', 'idx_task_reminder_due',
  'CREATE INDEX idx_task_reminder_due ON task_reminder(status, scheduled_at)');
CALL zhiqu_add_index_if_missing('task_reminder', 'idx_task_reminder_task',
  'CREATE INDEX idx_task_reminder_task ON task_reminder(task_id, status)');

DROP PROCEDURE zhiqu_add_column_if_missing;
DROP PROCEDURE zhiqu_add_index_if_missing;
