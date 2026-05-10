CREATE TABLE IF NOT EXISTS api_keys (
  id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  key_hash    TEXT NOT NULL UNIQUE,
  key_prefix  TEXT NOT NULL,
  created_by  TEXT,
  last_used_at TIMESTAMP,
  revoked_at  TIMESTAMP,
  created_at  TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_keys_hash_idx ON api_keys(key_hash)
  WHERE revoked_at IS NULL;
