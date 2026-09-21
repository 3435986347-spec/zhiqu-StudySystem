CREATE TABLE IF NOT EXISTS ai_conversation (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  conversation_key VARCHAR(50) DEFAULT 'default',
  title VARCHAR(100) DEFAULT '默认对话',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted TINYINT DEFAULT 0,
  UNIQUE KEY uk_ai_conversation_user_key (user_id, conversation_key),
  KEY idx_ai_conversation_user (user_id, deleted),
  CONSTRAINT fk_ai_conversation_user FOREIGN KEY (user_id) REFERENCES sys_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ai_message (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  conversation_id BIGINT NOT NULL,
  role VARCHAR(20) NOT NULL,
  content MEDIUMTEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted TINYINT DEFAULT 0,
  KEY idx_ai_message_conversation (conversation_id, id),
  KEY idx_ai_message_user_created (user_id, created_at),
  CONSTRAINT fk_ai_message_user FOREIGN KEY (user_id) REFERENCES sys_user(id),
  CONSTRAINT fk_ai_message_conversation FOREIGN KEY (conversation_id) REFERENCES ai_conversation(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS user_ai_memory (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL UNIQUE,
  memory_text TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_ai_memory_user FOREIGN KEY (user_id) REFERENCES sys_user(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
