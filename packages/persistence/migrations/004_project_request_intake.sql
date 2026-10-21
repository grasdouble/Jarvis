ALTER TABLE jarvis.requests
  ALTER COLUMN project_id DROP NOT NULL,
  ALTER COLUMN repository_id DROP NOT NULL,
  ALTER COLUMN mode DROP NOT NULL,
  ALTER COLUMN config_version DROP NOT NULL,
  ALTER COLUMN policy_hash DROP NOT NULL,
  ADD COLUMN prompt text,
  ADD COLUMN request_digest char(64) CHECK (request_digest IS NULL OR request_digest ~ '^[0-9a-f]{64}$'),
  ADD COLUMN request_kind text NOT NULL DEFAULT 'project' CHECK (request_kind IN ('project', 'dependency_update')),
  ADD COLUMN selector text,
  ADD COLUMN explicit_mode text CHECK (explicit_mode IS NULL OR explicit_mode IN ('plan', 'dev')),
  ADD COLUMN explicit_kind text CHECK (explicit_kind IS NULL OR explicit_kind IN ('project', 'dependency_update')),
  ADD COLUMN clarification jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(clarification) = 'array'),
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN profile_hash char(64) CHECK (profile_hash IS NULL OR profile_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN clarification_digest char(64) CHECK (clarification_digest IS NULL OR clarification_digest ~ '^[0-9a-f]{64}$');

ALTER TABLE jarvis.requests ADD CONSTRAINT requests_admission_binding CHECK (
  (state = 'clarification' AND (project_id IS NULL OR (repository_id IS NOT NULL AND config_version IS NOT NULL AND policy_hash IS NOT NULL)))
  OR (state <> 'clarification' AND project_id IS NOT NULL AND repository_id IS NOT NULL AND mode IS NOT NULL
      AND config_version IS NOT NULL AND policy_hash IS NOT NULL)
);

ALTER TABLE jarvis.requests ADD CONSTRAINT requests_prompt_size CHECK (prompt IS NULL OR length(prompt) BETWEEN 1 AND 20000);

GRANT SELECT, INSERT, UPDATE ON jarvis.requests, jarvis.tasks, jarvis.queue_entries, jarvis.outbox TO jarvis_app;
