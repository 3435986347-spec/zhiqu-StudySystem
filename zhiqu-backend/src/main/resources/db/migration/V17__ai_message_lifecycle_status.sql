ALTER TABLE ai_message
  ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'DONE' AFTER content,
  ADD COLUMN request_id VARCHAR(64) NULL AFTER status,
  ADD COLUMN provider_type VARCHAR(64) NULL AFTER request_id,
  ADD COLUMN model_name VARCHAR(128) NULL AFTER provider_type,
  ADD COLUMN completed_at DATETIME NULL AFTER web_search_enabled,
  ADD COLUMN error_message VARCHAR(500) NULL AFTER completed_at;

CREATE INDEX idx_ai_message_status_request
  ON ai_message(user_id, status, request_id, deleted);
