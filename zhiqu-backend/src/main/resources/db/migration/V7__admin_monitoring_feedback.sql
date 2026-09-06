ALTER TABLE sys_user
  ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'USER' AFTER avatar;

UPDATE sys_user
SET role = 'ADMIN'
WHERE username = 'admin';

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
