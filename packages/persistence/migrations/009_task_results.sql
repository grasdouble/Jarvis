CREATE TABLE task_results (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL,
  request_id uuid NOT NULL,
  project_id uuid NOT NULL,
  repository_id bigint NOT NULL,
  attempt_id uuid NOT NULL,
  lease_epoch bigint NOT NULL CHECK (lease_epoch > 0),
  mode text NOT NULL CHECK (mode IN ('plan', 'dev')),
  source_revision text NOT NULL CHECK (source_revision ~ '^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$'),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 80),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 120),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  payload_json jsonb NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
  digest char(64) NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id),
  UNIQUE (id, task_id),
  UNIQUE (id, task_id, project_id),
  FOREIGN KEY (task_id, project_id, repository_id) REFERENCES tasks(id, project_id, repository_id),
  FOREIGN KEY (request_id, project_id, repository_id) REFERENCES requests(id, project_id, repository_id),
  FOREIGN KEY (attempt_id, task_id, lease_epoch) REFERENCES task_attempts(id, task_id, lease_epoch)
);
CREATE INDEX task_results_project_task ON task_results(project_id, task_id);
ALTER TABLE queue_entries ADD COLUMN result_id uuid;
ALTER TABLE queue_entries
  ADD CONSTRAINT queue_entries_result_identity
    CHECK (result_id IS NULL OR (result_json ? 'id' AND result_json->>'id' = result_id::text)),
  ADD CONSTRAINT queue_entries_result_task_fk
    FOREIGN KEY (result_id, task_id) REFERENCES task_results(id, task_id);
REVOKE UPDATE, DELETE ON task_results FROM jarvis_app;
GRANT SELECT, INSERT ON task_results TO jarvis_app;
