ALTER TABLE rag_index_job
  ADD COLUMN lease_version BIGINT NOT NULL DEFAULT 0 AFTER locked_by;

CREATE INDEX idx_rag_job_lease
  ON rag_index_job(id, status, locked_by, lease_version);
