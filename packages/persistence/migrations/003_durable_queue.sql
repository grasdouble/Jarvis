ALTER TABLE jarvis.task_attempts ADD COLUMN worker_id text;

CREATE TABLE jarvis.queue_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL UNIQUE REFERENCES jarvis.tasks(id),
  event_id text NOT NULL UNIQUE CHECK (length(event_id) BETWEEN 1 AND 200),
  state text NOT NULL CHECK (state IN ('queued', 'leased', 'succeeded', 'failed', 'cancelled', 'reconciliation_required')),
  available_at timestamptz NOT NULL,
  deadline timestamptz NOT NULL,
  max_attempts integer NOT NULL CHECK (max_attempts > 0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_until timestamptz,
  worker_id text,
  attempt_id uuid,
  retry_base_delay_ms integer NOT NULL CHECK (retry_base_delay_ms >= 0),
  retry_max_delay_ms integer NOT NULL CHECK (retry_max_delay_ms >= retry_base_delay_ms),
  result_json jsonb,
  error_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (attempt_id, task_id) REFERENCES jarvis.task_attempts(id, task_id),
  CHECK ((state = 'leased') = (lease_until IS NOT NULL AND worker_id IS NOT NULL AND attempt_id IS NOT NULL)),
  CHECK (deadline > created_at),
  CHECK (result_json IS NULL OR (jsonb_typeof(result_json) = 'object'
    AND result_json ?& ARRAY['kind', 'id']
    AND result_json - ARRAY['kind', 'id'] = '{}'::jsonb
    AND result_json->>'kind' IN ('report', 'action_intent', 'checkpoint')
    AND result_json->>'id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$')),
  CHECK (error_json IS NULL OR jsonb_typeof(error_json) = 'object')
);

CREATE INDEX queue_entries_ready ON jarvis.queue_entries(available_at, created_at, id)
  WHERE state = 'queued';
CREATE INDEX queue_entries_expired_leases ON jarvis.queue_entries(lease_until, created_at, id)
  WHERE state = 'leased';
CREATE INDEX queue_entries_reconciliation ON jarvis.queue_entries(updated_at, id)
  WHERE state = 'reconciliation_required';

ALTER TABLE jarvis.outbox ADD COLUMN dedupe_key text;
CREATE UNIQUE INDEX outbox_dedupe_key ON jarvis.outbox(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX outbox_pending_order ON jarvis.outbox(available_at, created_at, id) WHERE delivered_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON jarvis.queue_entries TO jarvis_app;
GRANT SELECT, INSERT, UPDATE ON jarvis.task_attempts TO jarvis_app;
GRANT SELECT, INSERT, UPDATE ON jarvis.tasks, jarvis.requests, jarvis.outbox TO jarvis_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA jarvis TO jarvis_app;
REVOKE ALL ON jarvis.queue_entries FROM jarvis_agent;
REVOKE ALL ON jarvis.outbox FROM jarvis_agent;
