CREATE SCHEMA IF NOT EXISTS jarvis;
SET LOCAL search_path TO jarvis, public;

CREATE TABLE installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id bigint NOT NULL UNIQUE,
  app_id bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'suspended', 'revoked')),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id bigint NOT NULL,
  installation_id uuid NOT NULL REFERENCES installations(id),
  owner_id text NOT NULL,
  repository_name text NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'suspended', 'removed')),
  config_version integer NOT NULL CHECK (config_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, repository_id),
  UNIQUE (installation_id, repository_id)
);

CREATE TABLE project_config_versions (
  project_id uuid NOT NULL,
  repository_id bigint NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  config_json jsonb NOT NULL CHECK (jsonb_typeof(config_json) = 'object'),
  config_hash char(64) NOT NULL CHECK (config_hash ~ '^[0-9a-f]{64}$'),
  policy_hash char(64) NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, version),
  UNIQUE (project_id, repository_id, version),
  UNIQUE (project_id, repository_id, version, policy_hash),
  FOREIGN KEY (project_id, repository_id) REFERENCES projects(id, repository_id)
);

CREATE TABLE policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version integer NOT NULL UNIQUE CHECK (version > 0),
  canonical_json jsonb NOT NULL CHECK (jsonb_typeof(canonical_json) = 'object'),
  hash char(64) NOT NULL UNIQUE CHECK (hash ~ '^[0-9a-f]{64}$'),
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE project_config_versions ADD CONSTRAINT project_config_policy_hash
  FOREIGN KEY (policy_hash) REFERENCES policies(hash);

CREATE TABLE project_skills (
  project_id uuid NOT NULL,
  repository_id bigint NOT NULL,
  skill_id text NOT NULL,
  revision_digest char(64) NOT NULL CHECK (revision_digest ~ '^[0-9a-f]{64}$'),
  discovered_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, skill_id, revision_digest),
  FOREIGN KEY (project_id, repository_id) REFERENCES projects(id, repository_id)
);

CREATE TABLE project_skill_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  repository_id bigint NOT NULL,
  skill_id text NOT NULL,
  revision_digest char(64) NOT NULL CHECK (revision_digest ~ '^[0-9a-f]{64}$'),
  decision text NOT NULL CHECK (decision IN ('approved', 'revoked')),
  actor_id text NOT NULL,
  config_version integer NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, skill_id, revision_digest, id),
  FOREIGN KEY (project_id, repository_id, config_version)
    REFERENCES project_config_versions(project_id, repository_id, version),
  FOREIGN KEY (project_id, skill_id, revision_digest)
    REFERENCES project_skills(project_id, skill_id, revision_digest)
);
CREATE INDEX project_skill_approvals_current ON project_skill_approvals
  (project_id, skill_id, revision_digest, decided_at DESC);

CREATE TABLE requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  project_id uuid NOT NULL,
  repository_id bigint NOT NULL,
  mode text NOT NULL CHECK (mode IN ('plan', 'dev', 'review')),
  prompt_digest char(64) NOT NULL CHECK (prompt_digest ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('clarification', 'queued', 'running', 'completed', 'blocked', 'failed', 'cancelled')),
  idempotency_key text NOT NULL,
  config_version integer NOT NULL,
  policy_hash char(64) NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, idempotency_key),
  UNIQUE (id, project_id, repository_id),
  FOREIGN KEY (project_id, repository_id, config_version)
    REFERENCES project_config_versions(project_id, repository_id, version),
  FOREIGN KEY (project_id, repository_id, config_version, policy_hash)
    REFERENCES project_config_versions(project_id, repository_id, version, policy_hash)
);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE,
  project_id uuid NOT NULL,
  repository_id bigint NOT NULL,
  mode text NOT NULL CHECK (mode IN ('plan', 'dev', 'review')),
  revision text,
  profile_hash char(64) NOT NULL CHECK (profile_hash ~ '^[0-9a-f]{64}$'),
  policy_hash char(64) NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  config_version integer NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'running', 'review', 'completed', 'blocked', 'failed', 'cancelled')),
  dedupe_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, project_id, repository_id),
  UNIQUE (id, repository_id),
  FOREIGN KEY (request_id, project_id, repository_id)
    REFERENCES requests(id, project_id, repository_id),
  FOREIGN KEY (project_id, repository_id, config_version)
    REFERENCES project_config_versions(project_id, repository_id, version),
  FOREIGN KEY (project_id, repository_id, config_version, policy_hash)
    REFERENCES project_config_versions(project_id, repository_id, version, policy_hash)
);

CREATE TABLE task_revisions (
  task_id uuid NOT NULL,
  project_id uuid NOT NULL,
  repository_id bigint NOT NULL,
  revision_kind text NOT NULL CHECK (revision_kind IN ('source', 'base', 'head', 'artifact')),
  revision text NOT NULL,
  digest char(64) NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, revision_kind, digest),
  FOREIGN KEY (task_id, project_id, repository_id) REFERENCES tasks(id, project_id, repository_id)
);

CREATE TABLE task_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL,
  project_id uuid NOT NULL,
  repository_id bigint NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  lease_epoch bigint NOT NULL CHECK (lease_epoch > 0),
  lease_until timestamptz NOT NULL,
  sandbox_id text,
  state text NOT NULL CHECK (state IN ('active', 'succeeded', 'failed', 'cancelled', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (task_id, ordinal),
  UNIQUE (id, task_id, lease_epoch),
  UNIQUE (id, task_id),
  FOREIGN KEY (task_id, project_id, repository_id) REFERENCES tasks(id, project_id, repository_id),
  CHECK ((state = 'active') = (finished_at IS NULL))
);
CREATE UNIQUE INDEX one_active_attempt_per_task ON task_attempts(task_id) WHERE state = 'active';

CREATE TABLE task_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  project_id uuid NOT NULL,
  repository_id bigint NOT NULL,
  lease_epoch bigint NOT NULL,
  step text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  state_json jsonb NOT NULL CHECK (jsonb_typeof(state_json) = 'object'),
  state_digest char(64) NOT NULL CHECK (state_digest ~ '^[0-9a-f]{64}$'),
  skill_requirements jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(skill_requirements) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, attempt_id, lease_epoch, step),
  FOREIGN KEY (task_id, project_id, repository_id) REFERENCES tasks(id, project_id, repository_id),
  FOREIGN KEY (attempt_id, task_id, lease_epoch) REFERENCES task_attempts(id, task_id, lease_epoch)
);
CREATE INDEX task_checkpoints_latest ON task_checkpoints(task_id, attempt_id, lease_epoch, created_at DESC);

ALTER TABLE projects ADD CONSTRAINT projects_current_config_version
  FOREIGN KEY (id, repository_id, config_version)
  REFERENCES project_config_versions(project_id, repository_id, version)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE review_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL,
  project_id uuid NOT NULL,
  repository_id bigint NOT NULL,
  attempt_id uuid NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  report_json jsonb NOT NULL CHECK (jsonb_typeof(report_json) = 'object'),
  digest char(64) NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, digest),
  FOREIGN KEY (task_id, project_id, repository_id) REFERENCES tasks(id, project_id, repository_id),
  FOREIGN KEY (attempt_id, task_id) REFERENCES task_attempts(id, task_id)
);

CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL,
  project_id uuid NOT NULL,
  repository_id bigint NOT NULL,
  attempt_id uuid NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  plan_json jsonb NOT NULL CHECK (jsonb_typeof(plan_json) = 'object'),
  digest char(64) NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, digest),
  FOREIGN KEY (task_id, project_id, repository_id) REFERENCES tasks(id, project_id, repository_id),
  FOREIGN KEY (attempt_id, task_id) REFERENCES task_attempts(id, task_id)
);

CREATE TABLE pull_requests (
  project_id uuid NOT NULL,
  repository_id bigint NOT NULL,
  number integer NOT NULL CHECK (number > 0),
  head_sha text NOT NULL,
  base_sha text NOT NULL,
  remote_state text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, number),
  UNIQUE (project_id, repository_id, number),
  FOREIGN KEY (project_id, repository_id) REFERENCES projects(id, repository_id)
);

CREATE TABLE evidence_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  repository_id bigint NOT NULL,
  revision text NOT NULL,
  checks_json jsonb NOT NULL,
  reviews_json jsonb NOT NULL,
  rules_json jsonb NOT NULL,
  hash char(64) NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, repository_id) REFERENCES projects(id, repository_id),
  UNIQUE (project_id, revision, hash)
);

CREATE TABLE policy_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES requests(id),
  evidence_id uuid REFERENCES evidence_snapshots(id),
  artifact_digest char(64) CHECK (artifact_digest IS NULL OR artifact_digest ~ '^[0-9a-f]{64}$'),
  policy_hash char(64) NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('allow', 'deny', 'needs_human')),
  reasons text[] NOT NULL,
  effect_digest char(64) NOT NULL CHECK (effect_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE action_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_key text NOT NULL UNIQUE,
  task_id uuid NOT NULL REFERENCES tasks(id),
  revision text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('create_branch', 'create_pull_request')),
  state text NOT NULL CHECK (state IN ('pending', 'unknown', 'succeeded', 'failed', 'cancelled')),
  remote_id text,
  request_digest char(64) NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_active_publication_per_task ON action_intents(task_id)
  WHERE kind = 'create_pull_request' AND state IN ('pending', 'unknown', 'succeeded');

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor text NOT NULL,
  action text NOT NULL,
  resource text NOT NULL,
  correlation_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  details_hash char(64) NOT NULL CHECK (details_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  available_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id bigint NOT NULL,
  current_version integer NOT NULL CHECK (current_version > 0),
  lifecycle_state text NOT NULL CHECK (lifecycle_state IN ('proposed', 'validated', 'invalidated', 'expired', 'deleted')),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, repository_id),
  CHECK ((lifecycle_state = 'deleted') = (deleted_at IS NOT NULL))
);

CREATE TABLE knowledge_versions (
  item_id uuid NOT NULL,
  repository_id bigint NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  claim_kind text NOT NULL CHECK (claim_kind IN ('observation', 'hypothesis')),
  content text NOT NULL,
  source_ref text NOT NULL,
  source_hash char(64) NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  applicability_json jsonb NOT NULL CHECK (jsonb_typeof(applicability_json) = 'object'),
  review_after timestamptz,
  validated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  PRIMARY KEY (item_id, version),
  UNIQUE (item_id, repository_id, version),
  FOREIGN KEY (item_id, repository_id) REFERENCES knowledge_items(id, repository_id)
);
CREATE INDEX knowledge_versions_search ON knowledge_versions USING gin(search_vector);

CREATE TABLE task_contexts (
  task_id uuid NOT NULL,
  repository_id bigint NOT NULL,
  attempt_id uuid NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  profile_hash char(64) NOT NULL CHECK (profile_hash ~ '^[0-9a-f]{64}$'),
  input_hashes char(64)[] NOT NULL,
  selected_versions jsonb NOT NULL CHECK (jsonb_typeof(selected_versions) = 'array'),
  omissions jsonb NOT NULL CHECK (jsonb_typeof(omissions) = 'array'),
  budget jsonb NOT NULL CHECK (jsonb_typeof(budget) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, attempt_id),
  FOREIGN KEY (task_id, repository_id) REFERENCES tasks(id, repository_id),
  FOREIGN KEY (attempt_id, task_id) REFERENCES task_attempts(id, task_id)
);

CREATE TABLE forgotten_items (
  repository_id bigint NOT NULL,
  item_id uuid NOT NULL,
  forgotten_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repository_id, item_id),
  FOREIGN KEY (item_id, repository_id) REFERENCES knowledge_items(id, repository_id)
);

CREATE TABLE scheduled_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id text NOT NULL,
  local_date date NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  state text NOT NULL,
  UNIQUE (schedule_id, local_date),
  CHECK (period_end > period_start)
);

CREATE TABLE daily_digests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id text NOT NULL,
  local_date date NOT NULL,
  source_watermark timestamptz NOT NULL,
  body text NOT NULL,
  totals_json jsonb NOT NULL CHECK (jsonb_typeof(totals_json) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_id, local_date)
);

CREATE TABLE model_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES requests(id),
  task_id uuid REFERENCES tasks(id),
  attempt_id uuid REFERENCES task_attempts(id),
  purpose text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  profile_version integer NOT NULL,
  dispatched_at timestamptz,
  state text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id uuid REFERENCES usage_allocations(id),
  scope_id text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  limits_json jsonb NOT NULL CHECK (jsonb_typeof(limits_json) = 'object'),
  held_exposure numeric(24, 8) NOT NULL DEFAULT 0 CHECK (held_exposure >= 0),
  state text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  CHECK (period_end > period_start)
);

CREATE TABLE usage_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_request_id uuid NOT NULL REFERENCES model_requests(id),
  source text NOT NULL,
  observation_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  numeric_usage jsonb NOT NULL CHECK (jsonb_typeof(numeric_usage) = 'object'),
  mapping_version text NOT NULL,
  coverage text NOT NULL,
  observed_at timestamptz NOT NULL,
  UNIQUE (model_request_id, source, observation_id, revision)
);

CREATE TABLE usage_ledger (
  model_request_id uuid PRIMARY KEY REFERENCES model_requests(id),
  canonical_revision integer NOT NULL CHECK (canonical_revision > 0),
  reserved numeric(24, 8) NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  token_counts jsonb NOT NULL CHECK (jsonb_typeof(token_counts) = 'object'),
  field_statuses jsonb NOT NULL CHECK (jsonb_typeof(field_statuses) = 'object'),
  estimated_charge numeric(24, 8),
  provider_reported_charge numeric(24, 8),
  currency char(3),
  price_version text,
  reconciliation_state text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (estimated_charge IS NULL OR estimated_charge >= 0),
  CHECK (provider_reported_charge IS NULL OR provider_reported_charge >= 0)
);

CREATE INDEX task_attempts_lease_expiry ON task_attempts(lease_until) WHERE state = 'active';
CREATE INDEX outbox_ready ON outbox(available_at) WHERE delivered_at IS NULL;
CREATE INDEX model_requests_scope ON model_requests(request_id, task_id, attempt_id, dispatched_at);

CREATE OR REPLACE FUNCTION jarvis.reject_immutable_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable record: %', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER project_config_versions_immutable
  BEFORE UPDATE OR DELETE ON project_config_versions
  FOR EACH ROW EXECUTE FUNCTION jarvis.reject_immutable_mutation();
CREATE TRIGGER policies_immutable
  BEFORE UPDATE OR DELETE ON policies
  FOR EACH ROW EXECUTE FUNCTION jarvis.reject_immutable_mutation();
CREATE TRIGGER task_revisions_immutable
  BEFORE UPDATE OR DELETE ON task_revisions
  FOR EACH ROW EXECUTE FUNCTION jarvis.reject_immutable_mutation();
CREATE TRIGGER task_checkpoints_immutable
  BEFORE UPDATE OR DELETE ON task_checkpoints
  FOR EACH ROW EXECUTE FUNCTION jarvis.reject_immutable_mutation();
CREATE TRIGGER knowledge_versions_immutable
  BEFORE UPDATE OR DELETE ON knowledge_versions
  FOR EACH ROW EXECUTE FUNCTION jarvis.reject_immutable_mutation();
CREATE TRIGGER review_reports_immutable
  BEFORE UPDATE OR DELETE ON review_reports
  FOR EACH ROW EXECUTE FUNCTION jarvis.reject_immutable_mutation();
CREATE TRIGGER plans_immutable
  BEFORE UPDATE OR DELETE ON plans
  FOR EACH ROW EXECUTE FUNCTION jarvis.reject_immutable_mutation();
CREATE TRIGGER evidence_snapshots_immutable
  BEFORE UPDATE OR DELETE ON evidence_snapshots
  FOR EACH ROW EXECUTE FUNCTION jarvis.reject_immutable_mutation();
CREATE TRIGGER project_skill_approvals_immutable
  BEFORE UPDATE OR DELETE ON project_skill_approvals
  FOR EACH ROW EXECUTE FUNCTION jarvis.reject_immutable_mutation();
CREATE TRIGGER policy_decisions_immutable
  BEFORE UPDATE OR DELETE ON policy_decisions
  FOR EACH ROW EXECUTE FUNCTION jarvis.reject_immutable_mutation();
CREATE TRIGGER audit_events_insert_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION jarvis.reject_immutable_mutation();

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jarvis_app') THEN
    EXECUTE 'CREATE ROLE jarvis_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jarvis_agent') THEN
    EXECUTE 'CREATE ROLE jarvis_agent NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT';
  END IF;
END $$;
GRANT USAGE ON SCHEMA jarvis TO jarvis_app;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA jarvis TO jarvis_app;
REVOKE UPDATE, DELETE ON project_config_versions, policies, task_revisions,
  audit_events, task_checkpoints, knowledge_versions, review_reports, evidence_snapshots,
  project_skill_approvals, policy_decisions FROM jarvis_app;
REVOKE ALL ON schema_migrations FROM jarvis_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA jarvis TO jarvis_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA jarvis GRANT SELECT, INSERT, UPDATE ON TABLES TO jarvis_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA jarvis REVOKE UPDATE, DELETE ON TABLES FROM jarvis_app;
