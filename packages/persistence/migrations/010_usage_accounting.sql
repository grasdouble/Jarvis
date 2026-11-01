ALTER TABLE jarvis.model_requests
  ADD COLUMN operation_id uuid,
  ADD COLUMN dispatch_attempt integer,
  ADD COLUMN purpose_version text NOT NULL DEFAULT 'jarvis-usage-v1',
  ADD COLUMN requested_model text,
  ADD COLUMN lifecycle text NOT NULL DEFAULT 'unknown'
    CHECK (lifecycle IN ('prepared', 'dispatched', 'succeeded', 'failed', 'cancelled', 'unknown')),
  ADD COLUMN completed_at timestamptz,
  ADD COLUMN mapping_version text NOT NULL DEFAULT 'jarvis-usage-v1';

ALTER TABLE jarvis.model_requests
  ADD COLUMN runtime_coverage text NOT NULL DEFAULT 'unknown'
    CHECK (runtime_coverage IN ('observed', 'unknown', 'not_supported'));

COMMENT ON COLUMN jarvis.model_requests.runtime_coverage IS
  'Unknown until a trusted runtime observation is correlated by exact operation ID; observed runtime data is corroborative and non-additive.';
ALTER TABLE jarvis.model_requests
  ADD CONSTRAINT model_requests_operation_identity
    CHECK ((operation_id IS NULL) = (dispatch_attempt IS NULL)),
  ADD CONSTRAINT model_requests_dispatch_attempt_positive
    CHECK (dispatch_attempt IS NULL OR dispatch_attempt > 0);

CREATE UNIQUE INDEX model_requests_operation_attempt
  ON jarvis.model_requests(operation_id, dispatch_attempt)
  WHERE operation_id IS NOT NULL;

ALTER TABLE jarvis.usage_observations
  ADD COLUMN field_statuses jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(field_statuses) = 'object'),
  ADD COLUMN freshness text NOT NULL DEFAULT 'unknown'
    CHECK (freshness IN ('current', 'stale', 'unknown')),
  ADD COLUMN received_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE jarvis.usage_observations
  ADD COLUMN quota_signals jsonb
    CHECK (quota_signals IS NULL OR jsonb_typeof(quota_signals) = 'object');

ALTER TABLE jarvis.usage_ledger
  ADD COLUMN reconciliation_state_v2 text NOT NULL DEFAULT 'unknown'
    CHECK (reconciliation_state_v2 IN ('complete', 'partial', 'unknown', 'conflict'));

ALTER TABLE jarvis.usage_ledger
  ADD COLUMN canonical_observed_at timestamptz NOT NULL DEFAULT '-infinity'::timestamptz;

COMMENT ON COLUMN jarvis.usage_ledger.reserved IS 'Legacy unused field; issue #301 does not write or enforce monetary reservations.';
COMMENT ON COLUMN jarvis.usage_ledger.estimated_charge IS 'Legacy unused field; issue #301 leaves this null.';
COMMENT ON COLUMN jarvis.usage_ledger.provider_reported_charge IS 'Legacy unused field; issue #301 leaves this null.';
COMMENT ON COLUMN jarvis.usage_ledger.currency IS 'Legacy unused field; issue #301 leaves this null.';
COMMENT ON COLUMN jarvis.usage_ledger.price_version IS 'Legacy unused field; issue #301 leaves this null.';
