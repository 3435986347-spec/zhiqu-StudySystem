CREATE TABLE IF NOT EXISTS sys_user (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(50) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  nickname VARCHAR(50),
  avatar VARCHAR(255),
  total_study_minutes INT DEFAULT 0,
  consecutive_days INT DEFAULT 0,
  last_study_date DATE,
  achievement_points INT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
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
  deadline DATETIME,
  reminder_time DATETIME,
  completed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
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

-- ─── 已有数据库升级：为 study_task 添加 start_time / duration_minutes ───
-- 新装数据库上 CREATE TABLE 已包含这些列，执行时会报 "Duplicate column"，可忽略
-- 旧库请手动执行以下两句：
 ALTER TABLE study_task ADD COLUMN start_time DATETIME DEFAULT NULL COMMENT '开始时间' AFTER status;
 ALTER TABLE study_task ADD COLUMN duration_minutes INT DEFAULT NULL COMMENT '持续时长(分钟)' AFTER start_time;

-- ─── 任务周期重复功能：为 study_task 添加 3 个字段 ───
 ALTER TABLE study_task ADD COLUMN repeat_weeks INT DEFAULT NULL COMMENT '持续周数' AFTER duration_minutes;
 ALTER TABLE study_task ADD COLUMN repeat_group_id VARCHAR(36) DEFAULT NULL COMMENT '重复组ID' AFTER repeat_weeks;
 ALTER TABLE study_task ADD COLUMN repeat_week_number INT DEFAULT NULL COMMENT '第几周(从1开始)' AFTER repeat_group_id;
