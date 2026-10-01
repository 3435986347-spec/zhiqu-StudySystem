CREATE TABLE IF NOT EXISTS sys_user (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(50) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  nickname VARCHAR(50),
  avatar VARCHAR(255),
  role VARCHAR(20) NOT NULL DEFAULT 'USER',
  total_study_minutes INT DEFAULT 0,
  consecutive_days INT DEFAULT 0,
  last_study_date DATE,
  achievement_points INT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  version INT NOT NULL DEFAULT 0,
  deleted TINYINT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS study_task (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  quadrant TINYINT NOT NULL,
  priority TINYINT DEFAULT 0,
  status TINYINT DEFAULT 0,
  start_time DATETIME,
  duration_minutes INT,
  repeat_weeks INT,
  repeat_group_id VARCHAR(36),
  repeat_week_number INT,
  task_type VARCHAR(50),
  difficulty TINYINT,
  ai_reminder_reason VARCHAR(500),
  deadline DATETIME,
  reminder_time DATETIME,
  completed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  version INT NOT NULL DEFAULT 0,
  deleted TINYINT DEFAULT 0,
  CONSTRAINT fk_task_user FOREIGN KEY (user_id) REFERENCES sys_user(id)
);

CREATE TABLE IF NOT EXISTS study_record (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  task_id BIGINT,
  study_date DATE NOT NULL,
  duration_minutes INT NOT NULL,
  note VARCHAR(500),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_record_user FOREIGN KEY (user_id) REFERENCES sys_user(id),
  CONSTRAINT fk_record_task FOREIGN KEY (task_id) REFERENCES study_task(id)
);

CREATE TABLE IF NOT EXISTS achievement_def (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  code VARCHAR(50) UNIQUE,
  name VARCHAR(100),
  description VARCHAR(255),
  icon VARCHAR(255),
  points INT,
  condition_type VARCHAR(50),
  condition_value INT
);

CREATE TABLE IF NOT EXISTS user_achievement (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  achievement_id BIGINT NOT NULL,
  unlocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_ua_user FOREIGN KEY (user_id) REFERENCES sys_user(id),
  CONSTRAINT fk_ua_achievement FOREIGN KEY (achievement_id) REFERENCES achievement_def(id),
  UNIQUE KEY uk_user_achievement (user_id, achievement_id)
);

CREATE INDEX idx_task_user_quadrant ON study_task(user_id, quadrant);
CREATE INDEX idx_task_deadline ON study_task(deadline);
CREATE INDEX idx_record_user_date ON study_record(user_id, study_date);

CREATE TABLE IF NOT EXISTS user_feedback (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  username VARCHAR(50),
  nickname VARCHAR(50),
  content VARCHAR(1000) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  ip_address VARCHAR(80),
  user_agent VARCHAR(500),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted TINYINT DEFAULT 0,
  CONSTRAINT fk_user_feedback_user FOREIGN KEY (user_id) REFERENCES sys_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_user_feedback_status_created ON user_feedback(status, created_at);
CREATE INDEX idx_user_feedback_user_created ON user_feedback(user_id, created_at);

CREATE TABLE IF NOT EXISTS runtime_issue (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT,
  username VARCHAR(50),
  source VARCHAR(30) NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'ERROR',
  category VARCHAR(80),
  message VARCHAR(1000) NOT NULL,
  detail TEXT,
  page_url VARCHAR(1000),
  api_path VARCHAR(500),
  ip_address VARCHAR(80),
  user_agent VARCHAR(500),
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted TINYINT DEFAULT 0,
  CONSTRAINT fk_runtime_issue_user FOREIGN KEY (user_id) REFERENCES sys_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_runtime_issue_status_created ON runtime_issue(status, created_at);
CREATE INDEX idx_runtime_issue_source_created ON runtime_issue(source, created_at);

CREATE TABLE IF NOT EXISTS user_ai_config (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL UNIQUE,
  api_url VARCHAR(500) DEFAULT 'https://api.openai.com/v1/chat/completions',
  api_key VARCHAR(500),
  model_name VARCHAR(100) DEFAULT 'gpt-3.5-turbo',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_ai_config_user FOREIGN KEY (user_id) REFERENCES sys_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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

-- Existing database upgrade notes:
-- ALTER TABLE study_task ADD COLUMN task_type VARCHAR(50) DEFAULT NULL AFTER repeat_week_number;
-- ALTER TABLE study_task ADD COLUMN difficulty TINYINT DEFAULT NULL AFTER task_type;
-- ALTER TABLE study_task ADD COLUMN ai_reminder_reason VARCHAR(500) DEFAULT NULL AFTER difficulty;
-- ALTER TABLE user_reminder_setting ADD COLUMN qq_app_id VARCHAR(100) DEFAULT NULL AFTER webhook_url;
-- ALTER TABLE user_reminder_setting ADD COLUMN qq_app_secret VARCHAR(500) DEFAULT NULL AFTER qq_app_id;
-- ALTER TABLE user_reminder_setting ADD COLUMN qq_group_openid VARCHAR(200) DEFAULT NULL AFTER qq_app_secret;
-- ALTER TABLE user_reminder_setting ADD COLUMN qq_sandbox TINYINT DEFAULT 0 AFTER qq_group_openid;
-- ALTER TABLE user_reminder_setting ADD COLUMN pushplus_token VARCHAR(500) DEFAULT NULL AFTER qq_sandbox;

-- ─── 已有数据库升级：为 study_task 添加 start_time / duration_minutes ───
-- 新装数据库上 CREATE TABLE 已包含这些列，执行时会报 "Duplicate column"，可忽略
-- 旧库请手动执行以下两句：
-- ALTER TABLE study_task ADD COLUMN start_time DATETIME DEFAULT NULL COMMENT '开始时间' AFTER status;
-- ALTER TABLE study_task ADD COLUMN duration_minutes INT DEFAULT NULL COMMENT '持续时长(分钟)' AFTER start_time;

-- ─── 任务周期重复功能：为 study_task 添加 3 个字段 ───
-- ALTER TABLE study_task ADD COLUMN repeat_weeks INT DEFAULT NULL COMMENT '持续周数' AFTER duration_minutes;
-- ALTER TABLE study_task ADD COLUMN repeat_group_id VARCHAR(36) DEFAULT NULL COMMENT '重复组ID' AFTER repeat_weeks;
-- ALTER TABLE study_task ADD COLUMN repeat_week_number INT DEFAULT NULL COMMENT '第几周(从1开始)' AFTER repeat_group_id;
