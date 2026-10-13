-- invite_tokens: single-use tokens for owner account activation
-- token_hash is SHA-256(raw_token) in hex — raw token never stored
CREATE TABLE IF NOT EXISTS invite_tokens (
  id           uuid         PRIMARY KEY,
  tenant_id    uuid         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      uuid         NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  token_hash   varchar(64)  NOT NULL UNIQUE,
  purpose      varchar(40)  NOT NULL DEFAULT 'owner_activation',
  expires_at   timestamptz  NOT NULL,
  used_at      timestamptz,
  created_at   timestamptz  NOT NULL DEFAULT now()
);

-- idempotency_keys: caches POST /api/internal responses to handle retries safely
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          varchar(255) NOT NULL,
  endpoint     varchar(160) NOT NULL,
  response_json jsonb       NOT NULL,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (key, endpoint)
);

CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx
  ON idempotency_keys (created_at);
