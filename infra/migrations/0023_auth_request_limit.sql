-- Transient abuse-control counters. No raw email, client IP or reset token.
CREATE TABLE auth_request_limit (
  key TEXT PRIMARY KEY NOT NULL CHECK(length(key)=64),
  count INTEGER NOT NULL CHECK(count BETWEEN 1 AND 1001),
  expires_at INTEGER NOT NULL CHECK(expires_at>=0)
);
CREATE INDEX auth_request_limit_expiry ON auth_request_limit(expires_at);
