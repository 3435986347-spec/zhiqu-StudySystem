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
