-- Only private PoC tooling uses this table. No real recipient is stored.
CREATE TABLE reset_delivery_probe (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE REFERENCES user(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  CHECK(expires_at > 0)
);
