CREATE TABLE access_state (
  user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  must_change_password INTEGER NOT NULL DEFAULT 1 CHECK(must_change_password IN (0,1))
);
CREATE TABLE membership (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL, team_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('company_admin','team_admin','staff')),
  staff_id TEXT,
  PRIMARY KEY(user_id, tenant_id, team_id)
);
-- Separate synthetic storage probe. These are not production schedule tables.
CREATE TABLE schedule (
  tenant_id TEXT NOT NULL, team_id TEXT NOT NULL,
  version INTEGER NOT NULL, input_version INTEGER NOT NULL,
  published INTEGER NOT NULL DEFAULT 0, cancelled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(tenant_id, team_id)
);
CREATE TABLE participation (
  tenant_id TEXT NOT NULL, team_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(tenant_id, team_id),
  FOREIGN KEY(tenant_id, team_id) REFERENCES schedule(tenant_id, team_id)
);
CREATE TABLE operation (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, team_id TEXT NOT NULL,
  expected_version INTEGER NOT NULL, input_version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('publish','cancel')), actor TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  FOREIGN KEY(tenant_id, team_id) REFERENCES schedule(tenant_id, team_id)
);
CREATE TRIGGER operation_guard BEFORE INSERT ON operation
BEGIN
  SELECT RAISE(ABORT, 'VERSION_CONFLICT') WHERE NOT EXISTS (
    SELECT 1 FROM schedule WHERE tenant_id = NEW.tenant_id AND team_id = NEW.team_id
      AND version = NEW.expected_version AND input_version = NEW.input_version
  );
END;
CREATE TABLE revision (operation_id TEXT PRIMARY KEY REFERENCES operation(id), before_state TEXT NOT NULL);
CREATE TABLE audit (operation_id TEXT PRIMARY KEY REFERENCES operation(id), actor TEXT NOT NULL);
CREATE TABLE outbox (operation_id TEXT PRIMARY KEY REFERENCES operation(id), kind TEXT NOT NULL);
