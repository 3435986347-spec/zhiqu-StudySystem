ALTER TABLE ai_notebook_source
  ADD COLUMN content_hash CHAR(64) NULL AFTER parse_error,
  ADD COLUMN index_status VARCHAR(20) NOT NULL DEFAULT 'NOT_INDEXED' AFTER content_hash,
  ADD COLUMN index_version VARCHAR(120) NULL AFTER index_status,
  ADD COLUMN index_error VARCHAR(1000) NULL AFTER index_version,
  ADD COLUMN indexed_at DATETIME NULL AFTER index_error;

CREATE TABLE IF NOT EXISTS rag_index_generation (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  index_version VARCHAR(120) NOT NULL,
  collection_name VARCHAR(120) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'BUILDING',
  expected_source_count INT NOT NULL DEFAULT 0,
  indexed_source_count INT NOT NULL DEFAULT 0,
  error_message VARCHAR(1000) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME NULL,
  activated_at DATETIME NULL,
  retired_at DATETIME NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_rag_generation_collection (collection_name),
  KEY idx_rag_generation_status_created (status, created_at),
  KEY idx_rag_generation_version (index_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS rag_source_index_state (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  source_id BIGINT NOT NULL,
  generation_id BIGINT NOT NULL,
  index_version VARCHAR(120) NOT NULL,
  content_hash CHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  vector_count INT NOT NULL DEFAULT 0,
  last_error VARCHAR(1000) NULL,
  indexed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_rag_source_generation (source_id, generation_id),
  KEY idx_rag_source_state_generation_status (generation_id, status),
  KEY idx_rag_source_state_source_version (source_id, index_version),
  CONSTRAINT fk_rag_source_state_generation FOREIGN KEY (generation_id) REFERENCES rag_index_generation(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS rag_index_job (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  dedupe_key VARCHAR(255) NOT NULL,
  operation VARCHAR(40) NOT NULL,
  generation_id BIGINT NULL,
  user_id BIGINT NULL,
  notebook_id BIGINT NULL,
  source_id BIGINT NULL,
  content_hash CHAR(64) NULL,
  target_index_version VARCHAR(120) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  attempts INT NOT NULL DEFAULT 0,
  next_retry_at DATETIME NULL,
  locked_at DATETIME NULL,
  locked_by VARCHAR(120) NULL,
  last_error VARCHAR(1000) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  completed_at DATETIME NULL,
  UNIQUE KEY uk_rag_index_job_dedupe (dedupe_key),
  KEY idx_rag_job_claim (status, next_retry_at, id),
  KEY idx_rag_job_generation_status (generation_id, status),
  KEY idx_rag_job_source (source_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
