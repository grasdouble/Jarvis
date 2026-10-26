ALTER TABLE jarvis.task_attempts
  ADD COLUMN sandbox_idempotency_key text,
  ADD COLUMN sandbox_spec jsonb;

ALTER TABLE jarvis.task_attempts
  ADD CONSTRAINT task_attempt_sandbox_reservation_pair
  CHECK ((sandbox_idempotency_key IS NULL) = (sandbox_spec IS NULL));
