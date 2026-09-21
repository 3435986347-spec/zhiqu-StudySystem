ALTER TABLE ai_message
  ADD COLUMN reasoning_summary MEDIUMTEXT NULL AFTER content,
  ADD COLUMN citations_json MEDIUMTEXT NULL AFTER reasoning_summary,
  ADD COLUMN reasoning_mode VARCHAR(20) DEFAULT 'OFF' AFTER citations_json,
  ADD COLUMN web_search_enabled TINYINT(1) DEFAULT 0 AFTER reasoning_mode;
