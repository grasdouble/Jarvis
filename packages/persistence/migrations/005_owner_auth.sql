CREATE TABLE jarvis.owner_accounts (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  owner_id text NOT NULL UNIQUE CHECK (owner_id = 'owner'),
  password_hash text NOT NULL CHECK (length(password_hash) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT now(),
  password_updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jarvis.owner_sessions (
  token_digest char(64) PRIMARY KEY CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  owner_id text NOT NULL REFERENCES jarvis.owner_accounts(owner_id) ON DELETE CASCADE,
  csrf_token_digest char(64) NOT NULL CHECK (csrf_token_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (last_seen_at >= created_at)
);

CREATE INDEX owner_sessions_expiry ON jarvis.owner_sessions(expires_at)
  WHERE revoked_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON jarvis.owner_accounts TO jarvis_app;
GRANT SELECT, INSERT, UPDATE ON jarvis.owner_sessions TO jarvis_app;
