CREATE INDEX model_requests_dispatched_period
  ON jarvis.model_requests(dispatched_at, id)
  WHERE dispatched_at IS NOT NULL;
