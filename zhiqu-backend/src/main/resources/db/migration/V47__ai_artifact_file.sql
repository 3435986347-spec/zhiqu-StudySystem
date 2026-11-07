-- 生成到产物（第一百一十六轮）：代码模式在临时空间里生成的文件。存库不存盘：几个后端连同一个库，换台电脑也打得开；
-- 临时空间可以随时清，接着聊时从这里恢复。只做加法。
CREATE TABLE IF NOT EXISTS ai_artifact_file (
  id BIGINT NOT NULL AUTO_INCREMENT,
  artifact_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  conversation_id BIGINT NULL,
  path VARCHAR(512) NOT NULL,
  size_bytes BIGINT NOT NULL,
  sha256 CHAR(64) NOT NULL,
  content LONGBLOB NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ai_artifact_file_artifact (artifact_id),
  KEY idx_ai_artifact_file_user (user_id),
  KEY idx_ai_artifact_file_conversation (conversation_id, path)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
