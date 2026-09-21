CREATE TABLE IF NOT EXISTS study_routine (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  title VARCHAR(200) NOT NULL,
  description TEXT,
  frequency VARCHAR(30) NOT NULL DEFAULT 'DAILY',
  days_of_week VARCHAR(50),
  start_date DATE NOT NULL,
  end_date DATE,
  preferred_time TIME,
  duration_minutes INT,
  task_type VARCHAR(50),
  difficulty TINYINT DEFAULT 3,
  quadrant TINYINT DEFAULT 2,
  priority TINYINT DEFAULT 1,
  reminder_enabled TINYINT DEFAULT 1,
  reminder_offsets VARCHAR(200),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted TINYINT DEFAULT 0,
  CONSTRAINT fk_study_routine_user FOREIGN KEY (user_id) REFERENCES sys_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS study_routine_checkin (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  routine_id BIGINT NOT NULL,
  check_date DATE NOT NULL,
  status TINYINT DEFAULT 1,
  completed_at DATETIME,
  actual_minutes INT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted TINYINT DEFAULT 0,
  CONSTRAINT fk_routine_checkin_user FOREIGN KEY (user_id) REFERENCES sys_user(id),
  CONSTRAINT fk_routine_checkin_routine FOREIGN KEY (routine_id) REFERENCES study_routine(id),
  UNIQUE KEY uk_routine_checkin_day (routine_id, check_date, deleted)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_study_routine_active ON study_routine(user_id, start_date, end_date, deleted);
CREATE INDEX idx_routine_checkin_user_date ON study_routine_checkin(user_id, check_date, deleted);
