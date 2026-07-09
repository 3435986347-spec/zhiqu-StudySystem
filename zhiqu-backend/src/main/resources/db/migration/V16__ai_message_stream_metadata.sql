ALTER TABLE ai_message
  ADD COLUMN retrieval_status_json MEDIUMTEXT NULL AFTER citations_json,
  ADD COLUMN usage_json MEDIUMTEXT NULL AFTER retrieval_status_json;
