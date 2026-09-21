-- Run once on an existing zhiqu_db before using smart DDL reminders.
-- Fresh installs can use schema.sql directly.

ALTER TABLE study_task ADD COLUMN task_type VARCHAR(50) DEFAULT NULL AFTER repeat_week_number;
ALTER TABLE study_task ADD COLUMN difficulty TINYINT DEFAULT NULL AFTER task_type;
ALTER TABLE study_task ADD COLUMN ai_reminder_reason VARCHAR(500) DEFAULT NULL AFTER difficulty;

CREATE TABLE IF NOT EXISTS user_reminder_setting (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL UNIQUE,
  channel VARCHAR(30) DEFAULT 'QQ',
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

CREATE INDEX idx_task_reminder_due ON task_reminder(status, scheduled_at);
CREATE INDEX idx_task_reminder_task ON task_reminder(task_id, status);
