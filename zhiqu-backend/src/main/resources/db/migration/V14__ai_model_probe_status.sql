ALTER TABLE ai_model_config
  ADD COLUMN capability_probe_status VARCHAR(30) DEFAULT 'UNTESTED' AFTER capabilities,
  ADD COLUMN vision_status VARCHAR(30) DEFAULT 'UNTESTED' AFTER capability_probe_status,
  ADD COLUMN reasoning_status VARCHAR(30) DEFAULT 'UNTESTED' AFTER vision_status,
  ADD COLUMN last_probe_at DATETIME DEFAULT NULL AFTER reasoning_status;
