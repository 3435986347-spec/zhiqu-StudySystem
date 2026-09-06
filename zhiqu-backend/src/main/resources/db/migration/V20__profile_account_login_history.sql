DROP PROCEDURE IF EXISTS zhiqu_add_column_if_missing;

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
DELIMITER ;

CALL zhiqu_add_column_if_missing('sys_user', 'school',
  'ALTER TABLE sys_user ADD COLUMN school VARCHAR(100) NULL AFTER avatar');
CALL zhiqu_add_column_if_missing('sys_user', 'major',
  'ALTER TABLE sys_user ADD COLUMN major VARCHAR(100) NULL AFTER school');
CALL zhiqu_add_column_if_missing('sys_user', 'email',
  'ALTER TABLE sys_user ADD COLUMN email VARCHAR(120) NULL AFTER major');
CALL zhiqu_add_column_if_missing('sys_user', 'status',
  'ALTER TABLE sys_user ADD COLUMN status TINYINT NOT NULL DEFAULT 1 AFTER role');

DROP PROCEDURE zhiqu_add_column_if_missing;

CREATE TABLE IF NOT EXISTS login_log (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  ip VARCHAR(64) NULL,
  user_agent VARCHAR(300) NULL,
  login_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_login_log_user (user_id, login_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
